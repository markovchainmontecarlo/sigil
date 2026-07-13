import type { z } from "zod";

import { loadConfig, type AgentBinding } from "./config.js";
import type { RichSigilAgent, SigilContext } from "./context.js";
import type { AgentPromptOptions } from "./agent.js";
import { classifyProviderFailure, ProviderError, publicProviderFailure } from "./provider-failure.js";
import {
  retryOperation,
  type RecoveryResult,
  type WorkflowFailure,
} from "./recovery/index.js";

export type AgentOperationOptions = {
  stage: string;
  limit: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
};

export async function runFreshAgentOperation<T>(
  ctx: SigilContext,
  binding: string | AgentBinding,
  options: AgentOperationOptions,
  operation: (agent: RichSigilAgent, signal: AbortSignal) => Promise<T>,
): Promise<RecoveryResult<T>> {
  return runAgentOperation(
    ctx,
    options,
    (controls) => ctx.withAgent(
      binding,
      async (agent) => {
        try {
          return await operation(
            agentWithAttemptControls(agent, controls),
            controls.signal,
          );
        } catch (error) {
          const failure = classifyProviderFailure(error);
          throw new ProviderError(failure.evidence.message, {
            code: failure.code,
            account: agent.runtime?.profile,
            cause: error,
          });
        }
      },
    ),
  );
}

function agentWithAttemptControls(
  agent: RichSigilAgent,
  controls: import("./recovery/index.js").OperationAttemptControls,
): RichSigilAgent {
  return new Proxy(agent, {
    get(target, property, receiver) {
      if (property !== "prompt") return Reflect.get(target, property, receiver);
      return (
        text: string,
        arg?: unknown,
        options?: AgentPromptOptions,
      ) => {
        const attemptOptions = mergePromptOptions(options, controls);
        if (isSchemaArgument(arg)) {
          return target.promptWithOptions?.(text, arg, attemptOptions)
            ?? target.prompt(text, arg);
        }
        if (isWriteArgument(arg)) return Reflect.apply(target.prompt, target, [text, arg]);
        const plainOptions = mergePromptOptions(
          arg as AgentPromptOptions | undefined,
          controls,
        );
        return target.promptWithOptions?.(text, undefined, plainOptions)
          ?? target.prompt(text);
      };
    },
  });
}

function mergePromptOptions(
  options: AgentPromptOptions | undefined,
  controls: import("./recovery/index.js").OperationAttemptControls,
): AgentPromptOptions {
  return {
    ...options,
    signal: controls.signal,
    onProgress(kind) {
      options?.onProgress?.(kind);
      controls.progress(kind);
    },
  };
}

function isSchemaArgument(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value;
}

function isWriteArgument(value: unknown): boolean {
  return typeof value === "object" && value !== null && "writes" in value;
}

export async function promptAgentTurn(
  ctx: SigilContext,
  agent: RichSigilAgent,
  prompt: string,
  options: AgentOperationOptions,
): Promise<RecoveryResult<string>>;
export async function promptAgentTurn<T>(
  ctx: SigilContext,
  agent: RichSigilAgent,
  prompt: string,
  schema: z.ZodType<T>,
  options: AgentOperationOptions,
): Promise<RecoveryResult<T>>;
export async function promptAgentTurn<T>(
  ctx: SigilContext,
  agent: RichSigilAgent,
  prompt: string,
  schemaOrOptions: z.ZodType<T> | AgentOperationOptions,
  maybeOptions?: AgentOperationOptions,
): Promise<RecoveryResult<T | string>> {
  const schema = maybeOptions ? schemaOrOptions as z.ZodType<T> : undefined;
  const options = maybeOptions ?? schemaOrOptions as AgentOperationOptions;
  return runAgentOperation<T | string>(
    ctx,
    { ...options, limit: 0 },
    async (controls) => {
      const promptOptions = {
        signal: controls.signal,
        onProgress: controls.progress,
      };
      if (schema) {
        return agent.promptWithOptions?.(prompt, schema, promptOptions)
          ?? agent.prompt(prompt, schema);
      }
      return agent.promptWithOptions?.(prompt, undefined, promptOptions)
        ?? agent.prompt(prompt);
    },
  );
}

async function runAgentOperation<T>(
  ctx: SigilContext,
  options: AgentOperationOptions,
  operation: (controls: import("./recovery/index.js").OperationAttemptControls) => Promise<T>,
): Promise<RecoveryResult<T>> {
  const failures: WorkflowFailure[] = [];
  const capacityProfiles = new Set<string>();
  let chargedFailures = 0;
  for (;;) {
    const result = await retryOperation({
      limit: 0,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? loadConfig(ctx.repo).implement.idleTimeoutMs,
      cancellationGraceMs: loadConfig(ctx.repo).implement.cancellationGraceMs,
      operation: options.stage,
      run: (_attempt, controls) => operation(controls),
      failure: (error) => operationFailure(
        options.stage,
        error,
        chargedFailures + 1,
        false,
      ),
    });
    if (result.ok) return { ...result, attempts: chargedFailures + 1, failures };
    const provider = result.failure.provider;
    const profile = provider?.evidence.account;
    const rerouteKey = profile ?? provider?.fingerprint;
    const canReroute = provider?.disposition === "reroute"
      && rerouteKey !== undefined
      && !capacityProfiles.has(rerouteKey);
    const canRetry = provider?.disposition === "retry" && chargedFailures < options.limit;
    const failure = { ...result.failure, recoverable: canReroute || canRetry };
    failures.push(failure);
    await recordAgentFailure(ctx, failure);
    if (canReroute) {
      // A fresh-agent attempt has already closed its child and atomically released
      // its reservation before control reaches this decision. Capacity failover is
      // bounded by distinct assigned profiles and does not spend repair retries.
      capacityProfiles.add(rerouteKey);
      continue;
    }
    if (canRetry) {
      chargedFailures++;
      continue;
    }
    return { ok: false, failure, attempts: chargedFailures + 1, failures };
  }
}

async function recordAgentFailure(ctx: SigilContext, failure: WorkflowFailure): Promise<void> {
  if (failure.provider?.code === "idle_timeout") {
    await ctx.observe("agent-idle", { stage: failure.stage });
  }
  await ctx.observe("agent-classified-failure", {
    stage: failure.stage,
    code: failure.provider?.code ?? "unknown",
    disposition: failure.provider?.disposition ?? "terminal",
  });
  await ctx.observe("agent-operation-failed", {
    stage: failure.stage,
    attempt: failure.attempts,
    recoverable: failure.recoverable,
    failure: failure.provider ? publicProviderFailure(failure.provider) : {
      code: "unknown",
      disposition: "terminal",
      fingerprint: "unknown",
    },
  });
}

function operationFailure(
  stage: string,
  error: unknown,
  attempts: number,
  recoverable: boolean,
): WorkflowFailure {
  const provider = classifyProviderFailure(error);
  return {
    kind: "provider",
    stage,
    evidence: error instanceof Error ? error.message : String(error),
    attempts,
    recoverable: recoverable && provider.disposition !== "terminal",
    provider,
  };
}
