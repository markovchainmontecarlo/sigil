import type { z } from "zod";

import type { AgentBinding } from "./config.js";
import type { RichSigilAgent, SigilContext } from "./context.js";
import {
  retryOperation,
  type RecoveryResult,
  type WorkflowFailure,
} from "./recovery/index.js";

export type AgentOperationOptions = {
  stage: string;
  limit: number;
  timeoutMs: number;
};

export async function runFreshAgentOperation<T>(
  ctx: SigilContext,
  binding: string | AgentBinding,
  options: AgentOperationOptions,
  operation: (agent: RichSigilAgent) => Promise<T>,
): Promise<RecoveryResult<T>> {
  return runAgentOperation(
    ctx,
    options,
    () => ctx.withAgent(binding, operation),
  );
}

export async function promptAgentWithRecovery(
  ctx: SigilContext,
  agent: RichSigilAgent,
  prompt: string,
  options: AgentOperationOptions,
): Promise<RecoveryResult<string>>;
export async function promptAgentWithRecovery<T>(
  ctx: SigilContext,
  agent: RichSigilAgent,
  prompt: string,
  schema: z.ZodType<T>,
  options: AgentOperationOptions,
): Promise<RecoveryResult<T>>;
export async function promptAgentWithRecovery<T>(
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
    options,
    async () => {
      if (schema) return agent.prompt(prompt, schema);
      return agent.prompt(prompt);
    },
  );
}

async function runAgentOperation<T>(
  ctx: SigilContext,
  options: AgentOperationOptions,
  operation: () => Promise<T>,
): Promise<RecoveryResult<T>> {
  return retryOperation({
    limit: options.limit,
    timeoutMs: options.timeoutMs,
    operation: options.stage,
    run: operation,
    failure: (error, attempt, recoverable) => operationFailure(
      options.stage,
      error,
      attempt,
      recoverable,
    ),
    record: async (failure) => ctx.observe("agent-operation-failed", {
      stage: failure.stage,
      attempt: String(failure.attempts),
      recoverable: String(failure.recoverable),
      error: failure.evidence,
    }),
  });
}

function operationFailure(
  stage: string,
  error: unknown,
  attempts: number,
  recoverable: boolean,
): WorkflowFailure {
  return {
    kind: "provider",
    stage,
    evidence: error instanceof Error ? error.message : String(error),
    attempts,
    recoverable,
  };
}
