import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runWorkflow } from "sigil/server";

import { RunStore } from "./runs.js";
import { fixtureWorkflow } from "./workflow.js";

export async function workOnce(store: RunStore): Promise<void> {
  const job = store.acquire();
  const workspace = await mkdtemp(join(tmpdir(), "sigil-consumer-repo-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "sigil-consumer-artifacts-"));
  const cancellation = new AbortController();
  if (store.record(job.runId).cancelRequested) cancellation.abort(new Error("durable cancellation requested"));

  store.running(job.runId);
  const result = await runWorkflow(
    fixtureWorkflow,
    { repo: workspace, value: 21 },
    {
      runId: job.runId,
      workflowId: job.workflowId,
      artifactRoot,
      signal: cancellation.signal,
      onEvent: async (event) => store.event(job.runId, event),
    },
  );
  store.terminal(job.runId, result);
}
