import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { createContext } from "../context.js";
import { ProviderError, classifyProviderFailure } from "../provider-failure.js";
import type { OwnedProcessInfo, ProcessLifecycle } from "../process-lifecycle.js";
import type {
  RunWorkflowOptions,
  RunWorkflowResult,
  ServerErrorCode,
  ServerEvent,
  ServerEventDetails,
  ServerFailure,
  ServerRetryDisposition,
  ServerWorkflow,
} from "./types.js";

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

class EventSinkError extends Error {}

export async function runWorkflow<I extends { repo: string }, O>(
  workflow: ServerWorkflow<I, O>,
  input: I,
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult<O>> {
  const validation = validateOptions(input.repo, options);
  if (validation) return failed(options.runId, validation);

  const events = createEventDelivery(options);
  const processes = createProcessTracker();
  const context = createContext(input.repo, {
    storage: { ownership: "external", artifactRoot: options.artifactRoot },
    signal: options.signal,
    processLifecycle: processes.lifecycle,
    onObservation: (stage, details) => events.diagnostic(stage, details),
  });

  try {
    await events.lifecycle("started");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    await context.initialize();
    const result = await workflow(input, context);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    await events.lifecycle("succeeded");
    return { version: 1, status: "succeeded", runId: options.runId, result };
  } catch (error) {
    if (error instanceof EventSinkError) {
      return failed(options.runId, failure("event_sink_failed", "event delivery failed", "retry"));
    }
    if (options.signal?.aborted) {
      const settled = await processes.settle(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
      if (!settled) {
        return terminalFailure(
          events,
          options.runId,
          failure("cleanup_failed", "cleanup did not settle", "unsafe_to_retry"),
        );
      }
      try {
        await events.lifecycle("cancelled");
      } catch {
        return failed(options.runId, failure("event_sink_failed", "event delivery failed", "retry"));
      }
      return {
        version: 1,
        status: "cancelled",
        runId: options.runId,
        error: failure("cancelled", "workflow cancelled", "retry"),
      };
    }
    return terminalFailure(events, options.runId, publicFailure(error));
  }
}

function validateOptions(repo: string, options: RunWorkflowOptions): ServerFailure | undefined {
  if (!options.runId || !options.workflowId) {
    return failure("validation_failed", "runId and workflowId are required", "not_retryable");
  }
  if (!isAbsolute(options.artifactRoot)) {
    return failure("validation_failed", "artifactRoot must be absolute", "not_retryable");
  }
  const artifactRoot = canonicalPath(options.artifactRoot);
  const repository = canonicalPath(repo);
  const relation = relative(repository, artifactRoot);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    return failure("validation_failed", "artifactRoot must be isolated from the repository", "not_retryable");
  }
  return undefined;
}

function canonicalPath(path: string): string {
  const suffix: string[] = [];
  let existing = resolve(path);

  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }

  return resolve(realpathSync.native(existing), ...suffix);
}

function createEventDelivery(options: RunWorkflowOptions) {
  let sequence = 0;

  async function deliver(
    kind: ServerEvent["kind"],
    stage: string,
    details: ServerEventDetails = {},
  ): Promise<void> {
    const event: ServerEvent = {
      version: 1,
      kind,
      runId: options.runId,
      workflowId: options.workflowId,
      sequence: sequence++,
      stage,
      details: jsonSafe(details),
    };
    try {
      await options.onEvent(event);
    } catch {
      throw new EventSinkError("event sink rejected");
    }
  }

  return {
    lifecycle: (stage: string, details: ServerEventDetails = {}) => deliver("lifecycle", stage, details),
    diagnostic: (stage: string, details: ServerEventDetails) => deliver("diagnostic", stage, details),
  };
}

function createProcessTracker(): {
  lifecycle: ProcessLifecycle;
  settle(timeoutMs: number): Promise<boolean>;
} {
  const active = new Set<string>();
  const key = (process: OwnedProcessInfo) => `${process.identity.pid}:${process.identity.startIdentity}`;
  const lifecycle: ProcessLifecycle = {
    started(process) {
      active.add(key(process));
    },
    stopped(process) {
      active.delete(key(process));
    },
  };

  return {
    lifecycle,
    async settle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (active.size > 0 && Date.now() < deadline) await delay(10);
      return active.size === 0;
    },
  };
}

function publicFailure(error: unknown): ServerFailure {
  if (error instanceof ProviderError) {
    const provider = classifyProviderFailure(error);
    const retry = provider.disposition === "terminal" ? "not_retryable" : "retry";
    return failure("provider_failed", "provider operation failed", retry);
  }
  const code = errorCode(error);
  return failure(code, publicMessage(code), retryFor(code));
}

function errorCode(error: unknown): ServerErrorCode {
  if (!(error instanceof Error)) return "unexpected_failure";
  const name = error.name.toLowerCase();
  if (name.includes("validation")) return "validation_failed";
  if (name.includes("config")) return "configuration_failed";
  if (name.includes("workspace")) return "workspace_failed";
  if (name.includes("authority") || name.includes("permission")) return "authority_failed";
  return "workflow_failed";
}

function publicMessage(code: ServerErrorCode): string {
  if (code === "unexpected_failure") return "workflow execution failed unexpectedly";
  return code.replaceAll("_", " ");
}

function retryFor(code: ServerErrorCode): ServerRetryDisposition {
  if (code === "authority_failed" || code === "validation_failed") return "not_retryable";
  return "retry";
}

function failure(
  code: ServerErrorCode,
  message: string,
  retry: ServerRetryDisposition,
): ServerFailure {
  return { code, message, retry };
}

function failed<O>(runId: string, error: ServerFailure): RunWorkflowResult<O> {
  return { version: 1, status: "failed", runId, error };
}

async function terminalFailure<O>(
  events: ReturnType<typeof createEventDelivery>,
  runId: string,
  error: ServerFailure,
): Promise<RunWorkflowResult<O>> {
  try {
    await events.lifecycle("failed", { code: error.code });
    return failed(runId, error);
  } catch {
    return failed(runId, failure("event_sink_failed", "event delivery failed", "retry"));
  }
}

function jsonSafe(details: ServerEventDetails): ServerEventDetails {
  try {
    return JSON.parse(JSON.stringify(details)) as ServerEventDetails;
  } catch {
    return { unavailable: true };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
