import { readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { z } from "zod";

import type { AgentBinding } from "./config.js";
import type { AgentOptions, AgentPromptOptions, AgentRuntimeMetadata, SigilAgent } from "./agents.js";
import { createTextAgentFromGenerate } from "./agents.js";
import { OwnedPtyProcess, type OwnedPtyProcessOptions } from "./owned-pty-process.js";
import { ProviderError } from "./provider-failure.js";
import { resolveExecutionPolicy } from "./provider-capabilities.js";
import type { ClaudeProfile } from "./claude-profiles.js";

type TranscriptRecord = {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  message?: { role?: string; content?: unknown; stop_reason?: string };
};

export type ClaudePtyDependencies = {
  env: NodeJS.ProcessEnv;
  home: string;
  uuid(): string;
  executable(path: string): void;
  spawn(options: OwnedPtyProcessOptions): Promise<Pick<OwnedPtyProcess, "write" | "close" | "wait">>;
  readTranscript(path: string): Promise<string>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  promptSubmitDelayMs: number;
  promptAcceptanceTimeoutMs: number;
  promptAcceptanceRetries: number;
};

const READY = /(?:\? for shortcuts|bypass permissions|shift\+tab|claude code)/i;
const WAIT_MS = 10_000;
const POLL_MS = 20;
const PROMPT_SUBMIT_DELAY_MS = 800;
const PROMPT_ACCEPTANCE_TIMEOUT_MS = 90_000;
const PROMPT_ACCEPTANCE_RETRIES = 2;

const defaults: ClaudePtyDependencies = {
  env: process.env,
  home: process.env.HOME ?? "",
  uuid: randomUUID,
  executable: (path) => accessSync(path, constants.X_OK),
  spawn: (options) => OwnedPtyProcess.spawn(options),
  readTranscript: (path) => readFile(path, "utf8"),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  promptSubmitDelayMs: PROMPT_SUBMIT_DELAY_MS,
  promptAcceptanceTimeoutMs: PROMPT_ACCEPTANCE_TIMEOUT_MS,
  promptAcceptanceRetries: PROMPT_ACCEPTANCE_RETRIES,
};

export function claudePtyAvailable(
  dependencies: Partial<ClaudePtyDependencies> = {},
): boolean {
  try {
    resolveClaudeExecutable({ ...defaults, ...dependencies });
    return true;
  } catch {
    return false;
  }
}

export function createClaudePtyAgent(
  binding: AgentBinding,
  cwd: string,
  profile: ClaudeProfile,
  agentOptions: AgentOptions = {},
  dependencies: Partial<ClaudePtyDependencies> = {},
  sharedRuntime?: AgentRuntimeMetadata,
): SigilAgent {
  const deps = { ...defaults, ...dependencies };
  if (profile.accessClass !== "subscription" || "credentialSource" in profile.details) {
    throw new ProviderError("Claude PTY requires a subscription profile", { code: "profile_unavailable" });
  }
  const defaultConfiguration = "defaultConfiguration" in profile.details;
  const configurationDirectory = "configurationDirectory" in profile.details
    ? profile.details.configurationDirectory
    : join(deps.home, ".claude");
  let executable: string;
  try { executable = resolveClaudeExecutable(deps); } catch (cause) {
    throw new ProviderError("Claude CLI executable is unavailable", { code: "invalid_request", cause });
  }
  const sessionId = agentOptions.resumeSessionId ?? deps.uuid();
  if (!z.string().uuid().safeParse(sessionId).success) {
    throw new ProviderError("Claude session identifier is invalid", { code: "invalid_request" });
  }
  let initial = true;
  const runtime: AgentRuntimeMetadata = sharedRuntime ?? {
    binding: `${binding.provider}:${binding.model}`,
    providerSessionId: sessionId,
    active: false,
  };
  void agentOptions.onRuntimeUpdate?.(runtime);

  const generate = async (text: string, options?: AgentPromptOptions): Promise<string> => {
    const result = await runTurn({
      binding,
      cwd,
      deps,
      executable,
      sessionId,
      initial,
      text,
      options,
      agentOptions,
      runtime,
      configurationDirectory,
      defaultConfiguration,
    });
    initial = false;
    return result;
  };

  return createTextAgentFromGenerate(generate, undefined, runtime);
}

type Turn = {
  binding: AgentBinding;
  cwd: string;
  deps: ClaudePtyDependencies;
  executable: string;
  sessionId: string;
  initial: boolean;
  text: string;
  options?: AgentPromptOptions;
  agentOptions: AgentOptions;
  runtime: AgentRuntimeMetadata;
  configurationDirectory: string;
  defaultConfiguration: boolean;
};

async function runTurn(turn: Turn): Promise<string> {
  const transcript = transcriptPath(turn.configurationDirectory, turn.cwd, turn.sessionId);
  let terminal = "";
  let transcriptBody = await readOptional(turn.deps, transcript);
  let transcriptChangedAt = turn.deps.now();
  const process = await turn.deps.spawn({
    command: turn.executable,
    args: claudeArgs(turn),
    cwd: turn.cwd,
    env: childEnvironment(
      turn.deps.env,
      turn.defaultConfiguration ? undefined : turn.configurationDirectory,
    ),
    signal: turn.options?.signal,
    lifecycle: {
      started: async (info) => {
        await turn.agentOptions.processLifecycle?.started?.(info);
        turn.runtime.childProcessId = info.identity.pid;
        turn.runtime.childStartIdentity = info.identity.startIdentity;
        turn.runtime.active = true;
        await turn.agentOptions.onRuntimeUpdate?.(turn.runtime);
      },
      stopped: async (info) => {
        try {
          await turn.agentOptions.processLifecycle?.stopped?.(info);
        } finally {
          delete turn.runtime.childProcessId;
          delete turn.runtime.childStartIdentity;
          turn.runtime.active = false;
          await turn.agentOptions.onRuntimeUpdate?.(turn.runtime);
        }
      },
    },
    onData(data) {
      terminal = (terminal + new TextDecoder().decode(data)).slice(-4096);
      turn.options?.onProgress?.("provider");
    },
  });

  try {
    const terminalFailure = () => classifyTerminalFailure(stripAnsi(terminal));
    await waitUntil(turn, async () => {
      const startupFailure = terminalFailure();
      if (startupFailure) throw startupFailure;
      return READY.test(stripAnsi(terminal));
    }, "Claude CLI did not become ready", process);
    if (!turn.initial) {
      await waitUntil(turn, async () => {
        const next = await readOptional(turn.deps, transcript);
        if (next !== transcriptBody) {
          transcriptBody = next;
          transcriptChangedAt = turn.deps.now();
          turn.options?.onProgress?.("provider");
        }
        return turn.deps.now() - transcriptChangedAt >= 100;
      }, "Claude resumed session did not settle", process);
    }

    const baseline = parseTranscript(transcriptBody).length;
    await submitPrompt(turn, process, transcript, baseline, terminalFailure);

    return await matchingAnswer(turn, process, transcript, baseline, terminalFailure);
  } finally {
    await process.close();
  }
}

async function submitPrompt(
  turn: Turn,
  process: Pick<OwnedPtyProcess, "write" | "wait">,
  transcript: string,
  baseline: number,
  terminalFailure: () => ProviderError | undefined,
): Promise<void> {
  for (let attempt = 0; attempt <= turn.deps.promptAcceptanceRetries; attempt += 1) {
    await turn.agentOptions.onProviderEvent?.({ type: "provider-prompt-delivery", details: { attempt: attempt + 1, outcome: "delivered" } });
    process.write(turn.text);
    await turn.deps.sleep(turn.deps.promptSubmitDelayMs);
    process.write("\r");

    const accepted = await waitForPromptAcceptance(
      turn,
      process,
      transcript,
      baseline,
      terminalFailure,
    );
    if (accepted) {
      await turn.agentOptions.onProviderEvent?.({ type: "provider-prompt-accepted", details: { attempt: attempt + 1, outcome: "accepted" } });
      return;
    }
    await turn.agentOptions.onProviderEvent?.({ type: "provider-prompt-accepted", details: { attempt: attempt + 1, outcome: "not-accepted" } });
  }

  throw new ProviderError("Claude CLI did not accept the prompt", { code: "prompt_not_accepted" });
}

async function waitForPromptAcceptance(
  turn: Turn,
  process: Pick<OwnedPtyProcess, "wait">,
  transcript: string,
  baseline: number,
  terminalFailure: () => ProviderError | undefined,
): Promise<boolean> {
  const deadline = turn.deps.now() + turn.deps.promptAcceptanceTimeoutMs;

  while (turn.deps.now() < deadline) {
    turn.options?.signal?.throwIfAborted();
    const failure = terminalFailure();
    if (failure) throw failure;

    const body = await readOptional(turn.deps, transcript);
    const records = parseTranscript(body).slice(baseline);
    if (records.some((record) => userText(record) === normalize(turn.text))) return true;

    const exited = await Promise.race([
      process.wait().then(() => true),
      turn.deps.sleep(POLL_MS).then(() => false),
    ]);
    if (exited) {
      throw new ProviderError("Claude CLI exited before accepting the prompt", {
        code: "transient",
      });
    }
  }

  return false;
}

async function matchingAnswer(
  turn: Turn,
  process: Pick<OwnedPtyProcess, "wait">,
  path: string,
  baseline: number,
  terminalFailure: () => ProviderError | undefined,
): Promise<string> {
  let observed = "";
  return waitForValue(turn, async () => {
    const failure = terminalFailure();
    if (failure) throw failure;

    const body = await readOptional(turn.deps, path);
    if (body !== observed) {
      observed = body;
      turn.options?.onProgress?.("provider");
    }
    const records = parseTranscript(body).slice(baseline);
    const userIndex = records.findIndex((record) => userText(record) === normalize(turn.text));
    if (userIndex < 0) return undefined;
    const answer = records.slice(userIndex + 1)
      .filter((record) => record.type === "assistant" && record.message?.stop_reason === "end_turn")
      .map(assistantText)
      .find((text) => text.trim());
    return answer || undefined;
  }, "Claude did not persist the requested turn", process, false);
}

async function waitUntil(
  turn: Turn,
  check: () => Promise<boolean>,
  message: string,
  process: Pick<OwnedPtyProcess, "wait">,
): Promise<void> {
  await waitForValue(turn, async () => await check() ? true : undefined, message, process);
}

async function waitForValue<T>(turn: Turn, check: () => Promise<T | undefined>, message: string, process: Pick<OwnedPtyProcess, "wait">, timeout = true): Promise<T> {
  const deadline = timeout ? turn.deps.now() + WAIT_MS : undefined;
  while (deadline === undefined || turn.deps.now() < deadline) {
    turn.options?.signal?.throwIfAborted();
    const value = await check();
    if (value !== undefined) return value;
    const exited = await Promise.race([process.wait().then(() => true), turn.deps.sleep(POLL_MS).then(() => false)]);
    if (exited) throw new ProviderError("Claude CLI exited before completing the turn", { code: "transient" });
  }
  throw new ProviderError(message, { code: "transient" });
}

function claudeArgs(turn: Turn): string[] {
  const args = turn.initial ? ["--session-id", turn.sessionId] : ["--resume", turn.sessionId];
  const execution = resolveExecutionPolicy("claude-cli-pty", turn.binding.execution);
  return [
    ...args,
    "--model",
    turn.binding.model,
    "--effort",
    turn.binding.effort ?? "medium",
    ...execution.adapter.args,
  ];
}

function resolveClaudeExecutable(deps: ClaudePtyDependencies): string {
  const selected = deps.env.SIGIL_CLAUDE_PTY_BIN ?? deps.env.CLAUDE_BIN;
  if (selected) {
    deps.executable(selected);
    return selected;
  }
  for (const directory of (deps.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "claude");
    try { deps.executable(candidate); return candidate; } catch {}
  }
  throw new Error("Claude CLI executable was not found");
}

function childEnvironment(env: NodeJS.ProcessEnv, configurationDirectory?: string): Record<string, string> {
  const child: Record<string, string> = {};
  if (configurationDirectory) child.CLAUDE_CONFIG_DIR = configurationDirectory;
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "SHELL",
  ]) {
    const value = env[name];
    if (value) child[name] = value;
  }
  return child;
}

function transcriptPath(configurationDirectory: string, cwd: string, sessionId: string): string {
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(configurationDirectory, "projects", project, `${sessionId}.jsonl`);
}

async function readOptional(deps: ClaudePtyDependencies, path: string): Promise<string> {
  try { return await deps.readTranscript(path); } catch { return ""; }
}

function parseTranscript(body: string): TranscriptRecord[] {
  return body.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as TranscriptRecord]; } catch { return []; }
  });
}

function userText(record: TranscriptRecord): string | undefined {
  if (record.type !== "user" || record.message?.role !== "user") return undefined;
  if (typeof record.message.content === "string") return normalize(record.message.content);
  if (!Array.isArray(record.message.content)) return undefined;
  return normalize(record.message.content.filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join(""));
}

function assistantText(record: TranscriptRecord): string {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join("");
}

function normalize(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }

function classifyTerminalFailure(display: string): ProviderError | undefined {
  if (/not logged in|please run \/login|claude code requires authentication/i.test(display)) {
    return new ProviderError("Claude CLI authentication is required", {
      code: "authentication_failed",
    });
  }
  if (/unknown option:|invalid value for --(?:model|effort|permission-mode)/i.test(display)) {
    return new ProviderError("Claude CLI rejected its startup options", {
      code: "invalid_request",
    });
  }
  return undefined;
}
