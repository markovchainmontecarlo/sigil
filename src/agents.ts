import { approveAll, CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { ClaudeSDKAgent } from "@mastra/claude";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { type AgentBinding, loadConfig, resolveAgentBinding } from "./config.js";
import { retryPromptLoop } from "./gate.js";
import { readCodexAccountStatus } from "./codex-rate-limits.js";
import {
  recordActiveCapacityExhaustion,
  releaseCodexProfile,
  reserveCodexProfile,
  type CodexCapacityTelemetry,
} from "./codex-router.js";
import type { CodexAssignment, CapacityReader } from "./codex-router.js";
import type { CodexProfileStore, CodexUsage } from "./codex-profiles.js";
import type { CodexProfile } from "./codex-profiles.js";
import { OwnedCodexAcpConnection, type OwnedAcpEvent } from "./codex-acp.js";
import type { ProcessIdentity } from "./process-identity.js";
import type { ProcessLifecycle } from "./owned-process.js";
import { classifyProviderFailure, ProviderError, type ProviderFailure } from "./provider-failure.js";

export interface SigilAgent {
  prompt(text: string): Promise<string>;
  prompt<T>(text: string, schema: z.ZodType<T>): Promise<T>;
  promptWithOptions?<T>(
    text: string,
    schema: z.ZodType<T> | undefined,
    options: AgentPromptOptions,
  ): Promise<string | T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  readonly runtime?: AgentRuntimeMetadata;
}

export type AgentProgressKind = "text" | "tool" | "provider";
export type AgentPromptOptions = {
  signal?: AbortSignal;
  onProgress?: (kind: AgentProgressKind) => void;
};

export type AgentRuntimeMetadata = {
  binding?: string;
  profile?: string;
  providerSessionId?: string;
  childProcessId?: number;
  childStartIdentity?: string;
  usage?: CodexUsage;
  active?: boolean;
};

export type AgentOptions = {
  cwd?: string;
  capacityReader?: CapacityReader;
  profileStore?: CodexProfileStore;
  resumeSessionId?: string;
  onRuntimeUpdate?: (runtime: AgentRuntimeMetadata) => void | Promise<void>;
  processLifecycle?: ProcessLifecycle;
  onCapacityTelemetry?: (telemetry: CodexCapacityTelemetry) => void | Promise<void>;
};
export const SCHEMA_PROMPT_RETRY_ATTEMPTS = 2;
const DEFAULT_ACTIVE_CAPACITY_POLL_INTERVAL_MS = 30_000;
const ACTIVE_CAPACITY_STOP_GRACE_MS = 250;

export class SchemaPromptError extends Error {
  constructor(readonly issue: string) {
    super(`schema prompt failed: ${issue}`);
    this.name = "SchemaPromptError";
  }
}

export function isSchemaPromptError(error: unknown): error is SchemaPromptError {
  return error instanceof SchemaPromptError;
}

type GenerateResult<T = unknown> = { text: string; object?: T };
type ClaudeGenerate = <T>(text: string, options?: Record<string, unknown>) => Promise<GenerateResult<T>>;
type CodexGenerate = (text: string, options?: AgentPromptOptions) => Promise<string>;
type CopilotSessionLike = Pick<CopilotSession, "sendAndWait" | "abort" | "disconnect" | "on">;
type CopilotClientLike = {
  createSession(config: SessionConfig): Promise<CopilotSessionLike>;
  stop(): Promise<Error[]>;
};
type ClaudeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

export function agent(name: string, opts?: AgentOptions): SigilAgent;
export function agent(binding: AgentBinding, opts?: AgentOptions): SigilAgent;
export function agent(nameOrBinding: string | AgentBinding, opts: AgentOptions = {}): SigilAgent {
  const cwd = opts.cwd ?? process.cwd();
  const binding = typeof nameOrBinding === "string" ? resolveAgentBinding(nameOrBinding, loadConfig(cwd)) : nameOrBinding;
  if (binding.provider === "claude") return createClaude(binding, cwd);
  if (binding.provider === "codex") return createCodex(binding, cwd, opts);
  if (binding.provider === "copilot") return createCopilot(binding, cwd);
  throw new Error(`Unsupported agent provider "${String((binding as { provider?: unknown }).provider)}"`);
}

export async function withAgent<T>(binding: string | AgentBinding, fn: (agent: SigilAgent) => Promise<T>, opts?: AgentOptions): Promise<T> {
  const sigilAgent = typeof binding === "string" ? agent(binding, opts) : agent(binding, opts);
  try {
    return await fn(sigilAgent);
  } finally {
    await sigilAgent.close();
  }
}

function resolveInstalledCodexAcp(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    const packageFile = require.resolve("@agentclientprotocol/codex-acp/package.json");
    return join(dirname(packageFile), "dist", "index.js");
  } catch {
    return undefined;
  }
}

export function codexAcpAvailable(): boolean {
  return Boolean(process.env.SIGIL_CODEX_ACP_BIN ?? resolveInstalledCodexAcp());
}

export function copilotCliAvailable(): boolean {
  return spawnSync("copilot", ["--version"], { stdio: "ignore" }).status === 0;
}

export function copilotSdkAvailable(): boolean {
  return true;
}

function resolveCodexAcpBin(): { command: string; baseArgs: string[] } {
  const override = process.env.SIGIL_CODEX_ACP_BIN;
  if (override) return { command: override, baseArgs: [] };

  const adapter = resolveInstalledCodexAcp();
  if (adapter) return { command: process.execPath, baseArgs: [adapter] };

  throw new Error("Codex ACP adapter is not installed");
}

function createClaude(binding: AgentBinding, cwd: string): SigilAgent {
  const claude = new ClaudeSDKAgent({
    id: "sigil-claude-agent",
    name: "sigil-claude-agent",
    description: "Sigil Claude SDK agent",
    // bypassPermissions: pipeline turns run headless with no approver, and artifact
    // gates require the agent to write files (often outside cwd, e.g. the artifact dir).
    // This mirrors the codex binding's approval_policy=never + workspace-write below.
    sdkOptions: {
      cwd,
      model: binding.model,
      effort: claudeEffort(agentEffort(binding)),
      permissionMode: "bypassPermissions",
    },
  });
  return createClaudeAgentFromGenerate(<T>(text: string, options?: Record<string, unknown>) => claude.generate<T>(text, options));
}

function createCodex(binding: AgentBinding, cwd: string, options: AgentOptions): SigilAgent {
  let assignment: CodexAssignment | undefined;
  let acp: OwnedCodexAcpConnection | undefined;
  let usage: CodexUsage | undefined;
  let failure: ProviderFailure | undefined;
  let runtimeHeartbeat: ReturnType<typeof setInterval> | undefined;
  const runtime: AgentRuntimeMetadata = {
    binding: `${binding.provider}:${binding.model}`,
  };
  const readCapacity = options.capacityReader ?? (async (profile: CodexProfile) => (
    await readCodexAccountStatus(profile, { processLifecycle: options.processLifecycle })
  ).capacity);

  const connection = async (): Promise<OwnedCodexAcpConnection> => {
    if (acp) return acp;
    const admission = await reserveCodexProfile(
      readCapacity,
      options.profileStore,
    );
    for (const telemetry of admission.telemetry) await options.onCapacityTelemetry?.(telemetry);
    if (admission.status === "capacity-blocked") {
      throw new ProviderError(`Codex capacity blocked: ${admission.reasons.join("; ")}`, {
        code: "capacity_exhausted",
      });
    }
    if (admission.status === "configuration-error") {
      throw new ProviderError(`Codex profile configuration error: ${admission.errors.join("; ")}`, {
        code: "invalid_request",
      });
    }
    assignment = admission.assignment;
    runtime.profile = assignment.profile.name;
    acp = createCodexAcp(binding, cwd, assignment.profile.home, {
      resumeSessionId: options.resumeSessionId,
      onProcessStarted: async (identity) => {
        assignChildRuntime(runtime, identity);
        runtime.active = true;
        await options.onRuntimeUpdate?.(runtime);
        runtimeHeartbeat = setInterval(
          () => void options.onRuntimeUpdate?.(runtime),
          30_000,
        );
      },
      processLifecycle: options.processLifecycle,
    });
    return acp;
  };

  const generate = async (text: string, promptOptions?: AgentPromptOptions) => {
    const active = await connection();
    const chunks: string[] = [];
    let turnUsage: CodexUsage | undefined;
    const promptController = new AbortController();
    const cancelPrompt = () => promptController.abort(promptOptions?.signal?.reason);
    promptOptions?.signal?.addEventListener("abort", cancelPrompt, { once: true });
    if (promptOptions?.signal?.aborted) cancelPrompt();
    let capacityFailure: ProviderError | undefined;
    const guard = monitorActiveCodexCapacity(
      assignment,
      readCapacity,
      options.profileStore,
      async (telemetry) => {
        capacityFailure = new ProviderError(
          `Codex capacity floor reached for profile ${telemetry.profile}`,
          { code: "capacity_exhausted", account: telemetry.profile },
        );
        promptController.abort(capacityFailure);
        await options.onCapacityTelemetry?.(telemetry);
      },
    );
    try {
      for await (const event of active.promptStream(text, promptController.signal)) {
        if (event.type === "text") {
          chunks.push(event.text);
          promptOptions?.onProgress?.("text");
        }
        if (event.type === "session-update") turnUsage = usageFromEvent(event, turnUsage);
        if (event.type === "session-update" && event.update.sessionUpdate !== "usage_update") {
          promptOptions?.onProgress?.(providerProgressKind(event));
        }
      }
    } catch (error) {
      if (capacityFailure) {
        failure = classifyProviderFailure(capacityFailure);
        throw capacityFailure;
      }
      failure = classifyProviderFailure(error);
      throw error;
    } finally {
      promptOptions?.signal?.removeEventListener("abort", cancelPrompt);
      await guard.stop();
    }
    usage = addCodexUsage(usage, turnUsage);
    runtime.providerSessionId = active.sessionId;
    runtime.usage = usage;
    await options.onRuntimeUpdate?.(runtime);
    return chunks.join("");
  };

  return createCodexAgentFromGenerate(generate, async () => {
    if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
    await acp?.disconnect();
    if (assignment) await releaseCodexProfile(assignment.reservation.id, usage, failure, options.profileStore);
    runtime.active = false;
    await options.onRuntimeUpdate?.(runtime);
  }, runtime);
}

type ActiveCapacityGuard = {
  stop(): Promise<void>;
};

export function monitorActiveCodexCapacity(
  assignment: CodexAssignment | undefined,
  readCapacity: CapacityReader,
  store: CodexProfileStore | undefined,
  cancel: (telemetry: CodexCapacityTelemetry) => Promise<void>,
): ActiveCapacityGuard {
  const profile = assignment?.profile;
  if (!assignment || profile?.profileClass !== "subscription") return { stop: async () => {} };

  let stopped = false;
  let triggered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observation: Promise<void> | undefined;
  const interval = profile.activeCapacityPollIntervalMs
    ?? DEFAULT_ACTIVE_CAPACITY_POLL_INTERVAL_MS;
  const observe = async () => {
    const capacity = normalizeActiveCapacity(await readCapacity(profile));
    if (stopped || triggered || capacity.kind !== "available") return;
    const floor = profile.reserveFloorPercentage ?? 0;
    if (capacity.remainingPercentage > floor) return;

    triggered = await recordActiveCapacityExhaustion(
      assignment.reservation.id,
      capacity.observedAt,
      store,
    );
    if (!triggered) return;
    await cancel({
      profile: profile.name,
      capacityClass: "at-or-below-floor",
      configuredFloor: floor,
      admissionOutcome: "assigned",
      capacityTriggeredCancellation: true,
    });
  };
  const schedule = () => {
    if (stopped || triggered) return;
    timer = setTimeout(() => {
      observation = observe().catch(() => {}).finally(schedule);
    }, interval);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!observation) return;
      await Promise.race([
        observation,
        new Promise<void>((resolve) => setTimeout(resolve, ACTIVE_CAPACITY_STOP_GRACE_MS)),
      ]);
    },
  };
}

function normalizeActiveCapacity(
  capacity: Awaited<ReturnType<CapacityReader>>,
): import("./codex-router.js").SubscriptionCapacity {
  if ("kind" in capacity) return capacity;
  const observedAt = new Date().toISOString();
  if (capacity.available && capacity.remainingPercentage !== undefined) {
    return {
      kind: "available",
      available: true,
      observedAt,
      remainingPercentage: capacity.remainingPercentage,
    };
  }
  return { kind: "unavailable", available: false, observedAt };
}

function createCodexAcp(
  binding: AgentBinding,
  cwd: string,
  codexHome: string,
  options: {
    resumeSessionId?: string;
    onProcessStarted?: (identity: ProcessIdentity) => void | Promise<void>;
    processLifecycle?: ProcessLifecycle;
  } = {},
): OwnedCodexAcpConnection {
  const { command, baseArgs } = resolveCodexAcpBin();
  const args = [
    ...baseArgs,
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_mode=workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    `model=${binding.model}`,
    "-c",
    `model_reasoning_effort=${agentEffort(binding)}`,
    "-c",
    "model_auto_compact_token_limit=270000",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.multi_agent_v2=false",
  ];
  return new OwnedCodexAcpConnection({
    command,
    args,
    env: {
      NPM_CONFIG_CACHE: join(tmpdir(), "sigil-npm-cache"),
      CODEX_HOME: codexHome,
    },
    cwd,
    resumeSessionId: options.resumeSessionId,
    onProcessStarted: options.onProcessStarted,
    processLifecycle: options.processLifecycle,
  });
}

export async function primeCodexProfile(
  profile: CodexProfile,
  binding: AgentBinding,
  processLifecycle?: ProcessLifecycle,
): Promise<{
  before: Awaited<ReturnType<typeof readCodexAccountStatus>>;
  after: Awaited<ReturnType<typeof readCodexAccountStatus>>;
  windowStarted: boolean;
}> {
  const before = await readCodexAccountStatus(profile, { processLifecycle });
  if (before.profileClass !== "subscription") throw new Error(`profile ${profile.name} is not a subscription`);
  if (before.capacity.kind === "available") return { before, after: before, windowStarted: false };

  await using acp = createCodexAcp(binding, process.cwd(), profile.home, {
    processLifecycle,
  });
  for await (const _event of acp.promptStream("Reply with OK.")) {}
  const after = await readCodexAccountStatus(profile, { processLifecycle });
  return { before, after, windowStarted: after.capacity.kind === "available" };
}

function createCopilot(binding: AgentBinding, cwd: string): SigilAgent {
  const client = new CopilotClient({ workingDirectory: cwd });
  return createCopilotAgentFromClient(client, binding, cwd);
}

export function createClaudeAgentFromGenerate(generate: ClaudeGenerate, close: () => void | Promise<void> = () => {}): SigilAgent {
  let continued = false;

  return {
    prompt<T>(text: string, schemaOrOptions?: z.ZodType<T> | AgentPromptOptions, options?: AgentPromptOptions): Promise<string | T> {
      const schema = schemaOrOptions instanceof z.ZodType ? schemaOrOptions : undefined;
      const promptOptions = schemaOrOptions instanceof z.ZodType ? options : schemaOrOptions;
      return promptClaude(generate, continued, text, schema, promptOptions).then((result) => {
        continued = true;
        return result;
      });
    },
    promptWithOptions<T>(text: string, schema: z.ZodType<T> | undefined, options: AgentPromptOptions) {
      return promptClaude(generate, continued, text, schema, options).then((result) => {
        continued = true;
        return result;
      });
    },
    async close() {
      await close();
    },
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

export function createCodexAgentFromGenerate(
  generate: CodexGenerate,
  close: () => void | Promise<void> = () => {},
  runtime: AgentRuntimeMetadata = {},
): SigilAgent {
  return {
    prompt<T>(text: string, schemaOrOptions?: z.ZodType<T> | AgentPromptOptions, options?: AgentPromptOptions): Promise<string | T> {
      const schema = schemaOrOptions instanceof z.ZodType ? schemaOrOptions : undefined;
      const promptOptions = schema ? options : schemaOrOptions as AgentPromptOptions | undefined;
      return schema
        ? promptCodexWithSchema(generate, text, schema, SCHEMA_PROMPT_RETRY_ATTEMPTS, promptOptions)
        : generate(text, promptOptions);
    },
    promptWithOptions<T>(text: string, schema: z.ZodType<T> | undefined, options: AgentPromptOptions) {
      return schema
        ? promptCodexWithSchema(generate, text, schema, SCHEMA_PROMPT_RETRY_ATTEMPTS, options)
        : generate(text, options);
    },
    async close() {
      await close();
    },
    async [Symbol.asyncDispose]() {
      await this.close();
    },
    runtime,
  };
}

export function usageFromEvent(event: OwnedAcpEvent, previous?: CodexUsage): CodexUsage | undefined {
  if (event.type !== "session-update" || event.update.sessionUpdate !== "usage_update") return previous;
  const update = event.update;
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: update.used,
  };
}

function providerProgressKind(event: Extract<OwnedAcpEvent, { type: "session-update" }>): AgentProgressKind {
  const kind = event.update.sessionUpdate;
  return kind.includes("tool") ? "tool" : "provider";
}

function assignChildRuntime(runtime: AgentRuntimeMetadata, identity: ProcessIdentity): void {
  runtime.childProcessId = identity.pid;
  runtime.childStartIdentity = identity.startIdentity;
}

export function addCodexUsage(total?: CodexUsage, turn?: CodexUsage): CodexUsage | undefined {
  if (!turn) return total;
  if (!total) return turn;
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    reasoningTokens: total.reasoningTokens + turn.reasoningTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
  };
}

export function createCopilotAgentFromClient(client: CopilotClientLike, binding: AgentBinding, cwd: string): SigilAgent {
  let session: Promise<CopilotSessionLike> | undefined;

  const getSession = () => {
    session ??= client.createSession({
      model: binding.model,
      reasoningEffort: reasoningEffort(agentEffort(binding)),
      workingDirectory: cwd,
      onPermissionRequest: approveAll,
    });
    return session;
  };

  return createCopilotAgentFromGenerate(
    async (text, options) => {
      const active = await getSession();
      const unsubscribe = active.on((event) => {
        if (event.type === "assistant.message_delta") options?.onProgress?.("text");
        else options?.onProgress?.("provider");
      });
      const abort = () => void active.abort();
      options?.signal?.addEventListener("abort", abort, { once: true });

      try {
        options?.signal?.throwIfAborted();
        const response = await active.sendAndWait({ prompt: text });
        return response?.data.content ?? "";
      } finally {
        options?.signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
    async () => {
      if (session) await (await session).disconnect();
      await client.stop();
    },
  );
}

export function createCopilotAgentFromGenerate(generate: CodexGenerate, close: () => void | Promise<void> = () => {}): SigilAgent {
  return createCodexAgentFromGenerate(generate, close);
}

async function promptClaude<T>(
  generate: ClaudeGenerate,
  continued: boolean,
  text: string,
  schema?: z.ZodType<T>,
  promptOptions?: AgentPromptOptions,
): Promise<string | T> {
  let options: Record<string, unknown> | undefined = schema ? { structuredOutput: { schema } } : undefined;
  const abortController = new AbortController();
  const abort = () => abortController.abort(promptOptions?.signal?.reason);
  promptOptions?.signal?.addEventListener("abort", abort, { once: true });
  if (promptOptions?.signal?.aborted) abort();
  options = {
    ...(options ?? {}),
    sdkOptions: {
      ...(continued ? { continue: true } : {}),
      abortController,
    },
  };

  let result: GenerateResult<T>;
  try {
    result = await generate<T>(text, options);
  } finally {
    promptOptions?.signal?.removeEventListener("abort", abort);
  }
  if (!schema) return result.text;
  const checked = schema.safeParse(result.object);
  if (!checked.success) {
    throw new SchemaPromptError(`schema invalid: ${formatZodIssues(checked.error)}`);
  }
  return checked.data;
}

function agentEffort(binding: AgentBinding): string {
  return binding.effort ?? "medium";
}

function claudeEffort(value: string | undefined): ClaudeReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return undefined;
}

function reasoningEffort(value: string | undefined): CopilotReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

export async function promptCodexWithSchema<T>(
  generate: CodexGenerate,
  text: string,
  schema: z.ZodType<T>,
  attempts = SCHEMA_PROMPT_RETRY_ATTEMPTS,
  options?: AgentPromptOptions,
): Promise<T> {
  let reply = "";
  const result = await retryPromptLoop<{ ok: true; value: T }>({
    initialPrompt: schemaPrompt(text),
    attempts,
    runTurn: async (turnPrompt) => {
      reply = await generate(turnPrompt, options);
    },
    validate: async () => validateJsonReply(reply, schema),
    correctionPrompt: schemaCorrectionPrompt,
    defaultIssue: "schema gate failed",
  });

  if (result.ok) return result.value;
  throw new SchemaPromptError(result.issue);
}

function schemaPrompt(text: string): string {
  return `${text}\n\nReply with valid JSON only. Do not wrap the JSON in markdown.`;
}

function schemaCorrectionPrompt(issue: string, originalPrompt: string): string {
  return `Your previous turn failed its schema gate: ${issue}. You MUST reply with valid JSON only matching the requested schema. Original instruction follows.\n\n${originalPrompt}`;
}

function validateJsonReply<T>(reply: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; issue: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch (error) {
    return { ok: false, issue: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, issue: `schema invalid: ${formatZodIssues(checked.error)}` };
  return { ok: true, value: checked.data };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
