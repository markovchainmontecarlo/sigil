import { RunStore } from "./runs.js";

export function acceptRun(store: RunStore, request: unknown): { runId: string } {
  if (!request || typeof request !== "object") throw new TypeError("request must be an object");
  const value = request as { runId?: unknown; cancelRequested?: unknown };
  if (typeof value.runId !== "string" || value.runId.length === 0) throw new TypeError("runId is required");
  const cancelRequested = value.cancelRequested === true;

  store.accept(value.runId, cancelRequested);
  store.enqueue({ runId: value.runId, workflowId: "fixture-workflow", cancelRequested });

  return { runId: value.runId };
}
