# Run Sigil from a server application

Use a durable application queue and a Node-compatible worker for long-running Sigil work. The request handler records the run and enqueues the job before it returns. The worker owns repository isolation, calls `sigil/server`, persists events, and writes one terminal result.

```text
client -> server handler -> durable run record -> queue -> Node worker
                                                     -> isolated workspace
                                                     -> runWorkflow
                                                     -> events/result/artifacts
```

Install the verified registry package in the application:

```sh
npm install sigil
```

## Choose the job input

- In AI-assisted development, the application's code assistant or user-facing assistant produces a task graph from agreed requirements. Validate it through `sigil/contracts`, then enqueue `implement` with that graph.
- In agentic development, enqueue `plan`, `probePlan`, or `softwareChange` so Sigil produces the task graph from an intent or brief.

Both inputs enter the same implementation workflow after validation.

## Request handler

The following interfaces stand for application-owned database and queue adapters. Their methods must be durable before their promises resolve.

```ts
type RunRequest = { workflowId: "change"; intent: string };
type QueuedRun = { runId: string; workflowId: "change"; intent: string };

interface Runs {
  create(input: { workflowId: string; state: "accepted" }): Promise<{ runId: string }>;
}

interface Queue {
  enqueue(job: QueuedRun): Promise<void>;
}

export async function acceptRun(runs: Runs, queue: Queue, request: RunRequest) {
  if (request.workflowId !== "change" || request.intent.trim() === "") {
    throw new TypeError("invalid run request");
  }

  const run = await runs.create({ workflowId: request.workflowId, state: "accepted" });
  await queue.enqueue({ runId: run.runId, ...request });

  return { status: "accepted" as const, runId: run.runId };
}
```

Do not start the workflow in an untracked promise after sending the response. A process restart after the response would otherwise lose ownership of the run.

## Worker

The worker acquires one leased job, creates an isolated repository and an absolute artifact root outside that repository, bridges the durable cancellation field to `AbortController`, and persists every SDK event before `runWorkflow` resolves.

```ts
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { softwareChange } from "sigil";
import { runWorkflow, type RunWorkflowResult, type ServerEvent } from "sigil/server";

type Job = { runId: string; workflowId: "change"; intent: string };

interface AcquiredJob extends AsyncDisposable {
  job: Job;
  cancellationRequested(): Promise<boolean>;
  watchCancellation(abort: () => void): Disposable;
  persistEvent(event: ServerEvent): Promise<void>;
  persistTerminal(result: RunWorkflowResult<unknown>): Promise<void>;
}

export async function workOnce(acquired: AcquiredJob) {
  await using jobLease = acquired;
  const workspace = await mkdtemp(join(tmpdir(), "sigil-repository-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "sigil-artifacts-"));
  const cancellation = new AbortController();
  if (await acquired.cancellationRequested()) cancellation.abort();
  using cancellationWatch = acquired.watchCancellation(() => cancellation.abort());

  const result = await runWorkflow(
    softwareChange,
    { repo: workspace, intent: jobLease.job.intent },
    {
      runId: jobLease.job.runId,
      workflowId: jobLease.job.workflowId,
      artifactRoot,
      signal: cancellation.signal,
      onEvent: (event) => jobLease.persistEvent(event),
    },
  );

  await jobLease.persistTerminal(result);
}
```

The terminal write should enforce uniqueness by run ID. A cancelled result is returned only after SDK cleanup settles. A cleanup failure is a typed failure and must not be recorded as a successful cancellation.

## Application responsibilities

The application owns:

- user and service authentication;
- authorization for repositories and workflow selection;
- durable run records and terminal-result uniqueness;
- queueing, worker leases, retries, and abandoned-worker recovery;
- isolated repository workspaces;
- provider credentials, repository credentials, and tenant secret separation;
- concurrency limits, quotas, and cancellation requests;
- artifact retention and external artifact storage;
- user-visible event delivery;
- explicit permission to push, open pull requests, merge, or deploy.

Sigil does not turn developer-local subscription credentials into hosted shared credentials. Provision provider authentication appropriate to the worker and tenant model.

## Runtime boundary

Full workflows require Node-compatible filesystem, process, and child-process facilities. `sigil/contracts` is the browser-oriented contract surface, but consumers must still test their chosen bundler. Do not import `sigil` or `sigil/server` into browser, Edge, or restricted serverless code. Do not run long work inside an HTTP request lifecycle.

The `sigil` CLI is a separate Bun deployment shape. Its `run-sigil` command compiles TypeScript at runtime and records local detached-run files. Those files are useful for local operation, but they are not an application database, queue, or lease system.
