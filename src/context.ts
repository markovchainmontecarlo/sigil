import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";

import { agent as createAgent, isSchemaPromptError, type AgentOptions, type AgentPromptOptions, type AgentRuntimeMetadata, type SigilAgent } from "./agents.js";
import { loadConfig, type AgentBinding, type ContextEntry } from "./config.js";
import { emit as gateEmit, evalGate, type EmitOptions, type EmitResult, type EvalGateResult } from "./gate.js";
import { createArtifactRoot, ensureRunStorageIgnored } from "./paths.js";
import { OwnedProcess, type ProcessLifecycle } from "./owned-process.js";

export type LoadedContextEntry = {
  path: string;
  absolutePath: string;
  update: boolean;
  contents: string;
};

export type SkippedContextEntry = {
  path: string;
  absolutePath: string;
  update: boolean;
  reason: "missing";
};

export type LoadedContext = {
  entries: LoadedContextEntry[];
  skipped: SkippedContextEntry[];
};

export type AgentWrites = string | string[];
export type AgentWriteOptions<TWrites extends AgentWrites = AgentWrites> = EmitOptions & { writes: TWrites };
export type ArtifactHelpers = {
  dir: string;
  path(name: string): string;
  read(name: string): Promise<string>;
  write(name: string, contents: string): Promise<string>;
};
export type ShellCommand =
  | string
  | {
      command: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs?: number;
    };
export type ShellResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  message: string;
};
export type ParallelSettledResult<T> =
  | { ok: true; index: number; value: T }
  | { ok: false; index: number; error: unknown; message: string };

export interface RichSigilAgent extends SigilAgent {
  prompt(text: string): Promise<string>;
  prompt<T>(text: string, schema: z.ZodType<T>): Promise<T>;
  prompt(text: string, opts: AgentWriteOptions<string>): Promise<string>;
  prompt(text: string, opts: AgentWriteOptions<string[]>): Promise<Record<string, string>>;
}

export type ContextAgentFactory = (binding: string | AgentBinding, opts: AgentOptions & { cwd: string }) => SigilAgent;
export type CreateContextOptions = {
  createAgent?: ContextAgentFactory;
  artifactRoot?: string;
  agentOptions?: Omit<AgentOptions, "cwd">;
  onAgentRuntime?: (runtime: AgentRuntimeMetadata) => void | Promise<void>;
  signal?: AbortSignal;
  processLifecycle?: ProcessLifecycle;
};

export interface SigilContext {
  readonly repo: string;
  agent(binding: string | AgentBinding, options?: Omit<AgentOptions, "cwd" | "onRuntimeUpdate">): RichSigilAgent;
  withAgent<T>(binding: string | AgentBinding, fn: (agent: RichSigilAgent) => Promise<T>): Promise<T>;
  parallel<T>(jobs: Array<() => Promise<T>>): Promise<T[]>;
  parallelSettled<T>(jobs: Array<() => Promise<T>>): Promise<ParallelSettledResult<T>[]>;
  run<I, O>(child: (input: I, ctxOverride?: SigilContext) => Promise<O>, input: I): Promise<O>;
  sh(command: ShellCommand): Promise<ShellResult>;
  evals(name: string): Promise<EvalGateResult>;
  emit(agent: SigilAgent, prompt: string, fileOrFiles: string | string[], opts?: EmitOptions): Promise<EmitResult>;
  loadConfiguredContext(entries?: ContextEntry[]): Promise<LoadedContext>;
  renderContextBlock(entries?: ContextEntry[]): Promise<string>;
  issue(detail: string): void;
  observe(stage: string, details?: Record<string, string>): Promise<void>;
  fork(options: { artifactRoot: string; operationPath: string }): SigilContext;
  readonly issues: readonly string[];
  artifacts: ArtifactHelpers;
  readonly processLifecycle?: ProcessLifecycle;
}

export function createContext(
  repo: string,
  options: CreateContextOptions & {
    onObserve?: (stage: string, details: Record<string, string>) => Promise<void>;
  } = {},
): SigilContext {
  ensureRunStorageIgnored(repo);
  const issues: string[] = [];
  const dir = resolve(options.artifactRoot ?? createArtifactRoot(repo));
  const agentFactory: ContextAgentFactory = options.createAgent ?? ((binding, opts) => (
    typeof binding === "string" ? createAgent(binding, opts) : createAgent(binding, opts)
  ));
  const artifacts: ArtifactHelpers = {
    dir,
    path(name: string) {
      const path = resolve(join(dir, name));
      const rel = relative(dir, path);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return path;
      throw new Error(`artifact path escapes artifact dir: ${name}`);
    },
    async read(name) {
      return readFile(this.path(name), "utf8");
    },
    async write(name, contents) {
      const file = this.path(name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
      return file;
    },
  };
  const recordIssue = (detail: string) => issues.push(detail);
  const eventsFile = artifacts.path("events.jsonl");
  const statusFile = artifacts.path("status.json");
  let statusSequence = 0;

  const ctx: SigilContext = {
    repo,
    agent(binding, agentOptions = {}) {
      return wrapAgentForContext(agentFactory(binding, {
        cwd: repo,
        ...options.agentOptions,
        ...agentOptions,
        processLifecycle: options.processLifecycle,
        onRuntimeUpdate: options.onAgentRuntime,
        onCapacityTelemetry: async (telemetry) => {
          await options.agentOptions?.onCapacityTelemetry?.(telemetry);
          await agentOptions.onCapacityTelemetry?.(telemetry);
          await ctx.observe("agent-capacity", {
            profile: telemetry.profile,
            capacityClass: telemetry.capacityClass,
            configuredFloor: String(telemetry.configuredFloor),
            admissionOutcome: telemetry.admissionOutcome,
            capacityTriggeredCancellation: String(telemetry.capacityTriggeredCancellation),
          });
        },
      }), {
        artifactPath: artifacts.path,
        issue: recordIssue,
        observe: ctx.observe,
        role: typeof binding === "string" ? binding : `${binding.provider}:${binding.model}`,
      });
    },
    async withAgent(binding, fn) {
      const sigilAgent = ctx.agent(binding);
      let callbackError: unknown;
      try {
        return await fn(sigilAgent);
      } catch (error) {
        callbackError = error;
        throw error;
      } finally {
        try {
          await sigilAgent.close();
        } catch (closeError) {
          if (callbackError !== undefined) throw callbackError;
          throw closeError;
        }
      }
    },
    parallel(jobs) {
      return Promise.all(jobs.map((job) => job()));
    },
    parallelSettled(jobs) {
      return Promise.all(jobs.map((job, index) => runSettledJob(job, index, recordIssue)));
    },
    run(child, input) {
      return child(input, ctx);
    },
    sh(command) {
      return runShell(command, repo, options.signal, options.processLifecycle);
    },
    async evals(name) {
      await ctx.observe("gate-started", { gate: name });
      const result = await evalGate(name, {
        cwd: repo,
        signal: options.signal,
        processLifecycle: options.processLifecycle,
      });
      await ctx.observe("gate-completed", {
        gate: name,
        outcome: result.skipped ? "skipped" : result.ok ? "passed" : "failed",
        command: result.command ?? "not-configured",
        exitCode: result.exitCode === undefined ? "not-run" : String(result.exitCode),
      });
      return result;
    },
    emit(agent, prompt, fileOrFiles, opts) {
      return gateEmit(agent, prompt, fileOrFiles, opts);
    },
    loadConfiguredContext(entries) {
      return loadConfiguredContext(repo, entries ?? loadConfig(repo).context);
    },
    async renderContextBlock(entries) {
      return renderContextBlock(await ctx.loadConfiguredContext(entries));
    },
    issue(detail) {
      recordIssue(detail);
    },
    async observe(stage, details = {}) {
      const event = { at: new Date().toISOString(), stage, ...details };
      await mkdir(dirname(eventsFile), { recursive: true });
      await appendFile(eventsFile, `${JSON.stringify(event)}\n`);
      const temporary = `${statusFile}.${process.pid}.${statusSequence++}.tmp`;
      await writeFile(temporary, `${JSON.stringify(event, null, 2)}\n`);
      await rename(temporary, statusFile);
      const suffix = Object.values(details).length
        ? ` ${Object.values(details).join(" ")}`
        : "";
      process.stderr.write(`[sigil] ${stage}${suffix}\n`);
      await options.onObserve?.(stage, details);
    },
    fork(child) {
      return createContext(repo, {
        createAgent: agentFactory,
        artifactRoot: child.artifactRoot,
        onObserve: (stage, details) => ctx.observe(stage, {
          operationPath: child.operationPath,
          ...details,
        }),
        agentOptions: options.agentOptions,
        onAgentRuntime: options.onAgentRuntime,
        signal: options.signal,
        processLifecycle: options.processLifecycle,
      });
    },
    get issues() {
      return issues;
    },
    artifacts,
    processLifecycle: options.processLifecycle,
  };
  return ctx;
}

async function runSettledJob<T>(
  job: () => Promise<T>,
  index: number,
  issue: (detail: string) => void,
): Promise<ParallelSettledResult<T>> {
  try {
    return { ok: true, index, value: await job() };
  } catch (error) {
    const message = errorMessage(error);
    issue(`parallel job ${index + 1} failed: ${message}`);
    return { ok: false, index, error, message };
  }
}

async function runShell(
  command: ShellCommand,
  repo: string,
  contextSignal?: AbortSignal,
  processLifecycle?: ProcessLifecycle,
): Promise<ShellResult> {
  const cwd = typeof command === "string" ? repo : command.cwd ?? repo;
  const executable = typeof command === "string" ? "bash" : command.command;
  const args = typeof command === "string" ? ["-lc", command] : command.args ?? [];
  const env = { ...process.env, CI: process.env.CI ?? "1", ...(typeof command === "string" ? {} : command.env) };
  const commandSignal = typeof command === "string" ? undefined : command.signal;
  const timeoutMs = typeof command === "string" ? undefined : command.timeoutMs;
  const signals = [commandSignal, contextSignal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined]
    .filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  await using owned = await OwnedProcess.spawn({
    command: executable,
    args,
    cwd,
    env,
    kind: "shell",
    signal,
    lifecycle: processLifecycle,
  });
  const result = await owned.wait();
  const exitCode = result.exitCode;
  const ok = exitCode === 0;
  return {
    ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
    message: ok ? "command succeeded" : `command failed with exit code ${exitCode ?? "unknown"}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function wrapAgentForContext(
  base: SigilAgent,
  context: {
    artifactPath(name: string): string;
    issue(detail: string): void;
    role?: string;
    observe?: SigilContext["observe"];
    emit?: typeof gateEmit;
  },
): RichSigilAgent {
  const emit = context.emit ?? gateEmit;

  return {
    async prompt<T>(
      text: string,
      arg?: z.ZodType<T> | AgentWriteOptions<string> | AgentWriteOptions<string[]> | AgentPromptOptions,
      promptOptions?: AgentPromptOptions,
    ): Promise<string | T | Record<string, string>> {
      await context.observe?.("agent-started", { role: context.role ?? "agent" });
      const heartbeat = context.observe
        ? setInterval(() => void context.observe?.("agent-heartbeat", { role: context.role ?? "agent" }), 30_000)
        : undefined;
      const schema = isSchema(arg) ? arg : undefined;
      const options = schema ? promptOptions : isPromptOptions(arg) ? arg : undefined;
      const observedOptions: AgentPromptOptions = {
        ...options,
        onProgress(kind) {
          options?.onProgress?.(kind);
          void context.observe?.("agent-progress", {
            role: context.role ?? "agent",
            kind,
          });
        },
      };
      try {
        const result = await (isWriteOptions(arg)
          ? promptWithWrites(base, emit, context.artifactPath, context.issue, text, arg)
          : schema
            ? base.promptWithOptions?.(text, schema, observedOptions) ?? base.prompt(text, schema)
            : base.promptWithOptions?.(text, undefined, observedOptions) ?? base.prompt(text));
        await context.observe?.("agent-completed", { role: context.role ?? "agent" });
        return result as string | T | Record<string, string>;
      } catch (error) {
        if (isSchemaPromptError(error)) context.issue(`schema prompt failed: ${error.message}`);
        if (options?.signal?.aborted) {
          await context.observe?.("agent-cancelled", { role: context.role ?? "agent" });
        }
        await context.observe?.("agent-failed", { role: context.role ?? "agent", error: errorMessage(error) });
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
    promptWithOptions<T>(
      text: string,
      schema: z.ZodType<T> | undefined,
      options: AgentPromptOptions,
    ) {
      return schema
        ? Reflect.apply(this.prompt, this, [text, schema, options])
        : Reflect.apply(this.prompt, this, [text, options]);
    },
    close() {
      return base.close();
    },
    [Symbol.asyncDispose]() {
      return base[Symbol.asyncDispose]();
    },
  };
}

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value;
}

function isPromptOptions(value: unknown): value is AgentPromptOptions {
  return typeof value === "object"
    && value !== null
    && !isWriteOptions(value)
    && !isSchema(value);
}

function isWriteOptions(value: unknown): value is AgentWriteOptions {
  return typeof value === "object" && value !== null && "writes" in value;
}

async function promptWithWrites(
  base: SigilAgent,
  emit: typeof gateEmit,
  artifactPath: (name: string) => string,
  issue: (detail: string) => void,
  text: string,
  opts: AgentWriteOptions,
): Promise<string | Record<string, string>> {
  const single = typeof opts.writes === "string";
  const names: string[] = typeof opts.writes === "string" ? [opts.writes] : opts.writes;
  const files = names.map((name) => artifactPath(name));
  await Promise.all(files.map((file) => mkdir(dirname(file), { recursive: true })));
  const { writes: _writes, ...emitOpts } = opts;
  const result = await emit(base, writesPrompt(text, names, files), files, emitOpts);

  if (!result.ok) {
    issue(`agent writes failed (${names.join(", ")}): ${result.issue}`);
    return single ? "" : {};
  }

  if (single) return result.contents[0] ?? "";
  return Object.fromEntries(names.map((name, index) => [name, result.contents[index] ?? ""]));
}

function writesPrompt(text: string, names: string[], files: string[]): string {
  const targets = names.map((name, index) => `- ${name}: ${files[index]}`).join("\n");
  return `Write the requested artifact file(s) exactly at these paths:\n${targets}\n\nOriginal instruction follows.\n\n${text}`;
}

export function sigil<I, O>(name: string, body: (ctx: SigilContext, input: I & { repo: string }) => Promise<O>) {
  void name;
  return async (input: I & { repo: string }, ctxOverride?: SigilContext): Promise<O> => body(ctxOverride ?? createContext(input.repo), input);
}

export async function loadConfiguredContext(repo: string, entries: ContextEntry[] = []): Promise<LoadedContext> {
  const loaded: LoadedContextEntry[] = [];
  const skipped: SkippedContextEntry[] = [];

  for (const entry of entries) {
    const path = normalizeContextPath(repo, entry.path);
    const absolutePath = resolve(repo, path);
    try {
      loaded.push({ path, absolutePath, update: entry.update, contents: await readFile(absolutePath, "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push({ path, absolutePath, update: entry.update, reason: "missing" });
        continue;
      }
      throw error;
    }
  }

  return { entries: loaded, skipped };
}

export function renderContextBlock(context: LoadedContext): string {
  if (!context.entries.length && !context.skipped.length) return "";

  const lines = [
    "## Configured run context",
    "",
    "These files were loaded at the start of the run. Use them as orientation, then verify their claims against source files and runtime behavior before relying on them.",
    "`update: true` marks a drift-controlled write-back target. Keep that file true with the smallest in-place edit when this run makes one of its statements false.",
    "`update: false` marks read-only context unless the task explicitly declares that file as an output.",
  ];

  for (const entry of context.entries) {
    lines.push("", `### ${entry.path} (update: ${entry.update})`, "", "```", entry.contents.replace(/\s+$/, ""), "```");
  }

  if (context.skipped.length) {
    lines.push("", "### Configured context files not present", "");
    for (const entry of context.skipped) lines.push(`- ${entry.path} (update: ${entry.update}): missing`);
  }

  return lines.join("\n");
}

function normalizeContextPath(repo: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`context path must be repo-relative: ${path}`);
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`context path escapes repo: ${path}`);
  return rel.replaceAll("\\", "/");
}
