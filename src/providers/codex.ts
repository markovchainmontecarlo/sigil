import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentBinding } from "../config.js";
import { resolveExecutionPolicy } from "../provider-capabilities.js";
import { readCodexAccountStatus } from "../codex-rate-limits.js";
import { releaseCodexProfile, reserveCodexProfile, type CodexAdmission, type CodexAssignment, type CapacityReader } from "../codex-router.js";
import type { CodexProfileStore, CodexUsage, CodexProfile } from "../codex-profiles.js";
import { ProfileStoreError } from "../provider-profiles.js";
import { OwnedCodexAcpConnection, type OwnedAcpEvent } from "../codex-acp.js";
import type { ProcessIdentity } from "../process-identity.js";
import type { ProcessLifecycle } from "../owned-process.js";
import { classifyProviderFailure, ProviderError, type ProviderFailure } from "../provider-failure.js";
import { createTextAgentFromGenerate, type AgentOptions, type AgentPromptOptions, type AgentRuntimeMetadata, type AgentProgressKind, type SigilAgent } from "../agent.js";

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

function resolveCodexAcpBin(): { command: string; baseArgs: string[] } {
  const override = process.env.SIGIL_CODEX_ACP_BIN;
  if (override) return { command: override, baseArgs: [] };

  const adapter = resolveInstalledCodexAcp();
  if (adapter) return { command: process.execPath, baseArgs: [adapter] };

  throw new Error("Codex ACP adapter is not installed");
}

export function createCodexAgent(binding: AgentBinding, cwd: string, options: AgentOptions, runtime: AgentRuntimeMetadata): SigilAgent {
  let assignment: CodexAssignment | undefined;
  let acp: OwnedCodexAcpConnection | undefined;
  let usage: CodexUsage | undefined;
  let failure: ProviderFailure | undefined;
  let runtimeHeartbeat: ReturnType<typeof setInterval> | undefined;
  runtime.transport = "codex-acp";
  const readCapacity = options.capacityReader ?? (async (profile: CodexProfile) => (
    await readCodexAccountStatus(profile, { processLifecycle: options.processLifecycle })
  ).capacity);

  const connection = async (): Promise<OwnedCodexAcpConnection> => {
    if (acp) return acp;
    const admission = await reserveCodexAdmission(
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
    const reserved = admission.assignment;
    assignment = reserved;
    runtime.profile = reserved.profile.name;
    runtime.accessClass = reserved.profile.profileClass === "subscription" ? "subscription" : "metered-api";
    runtime.routingReason = "subscription-preferred";
    acp = createCodexAcp(binding, cwd, reserved.profile.home, {
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
      failure = classifyProviderFailure(error);
      throw error;
    } finally {
      promptOptions?.signal?.removeEventListener("abort", cancelPrompt);
    }
    usage = addCodexUsage(usage, turnUsage);
    runtime.providerSessionId = active.sessionId;
    runtime.usage = usage;
    await options.onRuntimeUpdate?.(runtime);
    return chunks.join("");
  };

  return createTextAgentFromGenerate(generate, async () => {
    if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
    await acp?.disconnect();
    if (assignment?.reservation) {
      await releaseCodexProfile(
        assignment.reservation.id,
        usage,
        failure,
        options.profileStore,
      );
    }
    runtime.active = false;
    await options.onRuntimeUpdate?.(runtime);
  }, runtime);
}

async function reserveCodexAdmission(
  readCapacity: CapacityReader,
  store: CodexProfileStore | undefined,
): Promise<CodexAdmission> {
  try {
    return await reserveCodexProfile(readCapacity, store);
  } catch (error) {
    if (!(error instanceof ProfileStoreError)) throw error;
    throw new ProviderError(`Codex profile configuration error: ${error.message}`, {
      code: "invalid_request",
      cause: error,
    });
  }
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
    ...resolveExecutionPolicy("codex-acp", binding.execution).adapter.args.flatMap((flag) => ["-c", flag]),
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

function agentEffort(binding: AgentBinding): string {
  return binding.effort ?? "medium";
}
