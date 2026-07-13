import type { SigilContext } from "../context.js";

export type ServerWorkflow<I, O> = (
  input: I,
  context?: SigilContext,
) => Promise<O>;

export type ServerEventDetails = Record<string, unknown>;

export type ServerEvent = {
  version: 1;
  kind: "lifecycle" | "diagnostic";
  runId: string;
  workflowId: string;
  sequence: number;
  stage: string;
  details: ServerEventDetails;
};

export type ServerErrorCode =
  | "validation_failed"
  | "configuration_failed"
  | "provider_failed"
  | "workspace_failed"
  | "authority_failed"
  | "workflow_failed"
  | "cancelled"
  | "cleanup_failed"
  | "event_sink_failed"
  | "unexpected_failure";

export type ServerRetryDisposition = "retry" | "not_retryable" | "unsafe_to_retry";

export type ServerFailure = {
  code: ServerErrorCode;
  message: string;
  retry: ServerRetryDisposition;
};

export type RunWorkflowOptions = {
  runId: string;
  workflowId: string;
  artifactRoot: string;
  signal?: AbortSignal;
  onEvent: (event: ServerEvent) => Promise<void>;
  cleanupTimeoutMs?: number;
};

export type RunWorkflowResult<O> =
  | { version: 1; status: "succeeded"; runId: string; result: O }
  | { version: 1; status: "cancelled"; runId: string; error: ServerFailure }
  | { version: 1; status: "failed"; runId: string; error: ServerFailure };
