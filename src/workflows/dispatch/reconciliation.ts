import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateTaskGraph, taskGraphDigest } from "../../contracts/task-graph.js";
import { reconcileRepository } from "../../recovery/git-snapshot.js";
import { acquireRunLock, reconcileProcessLeases } from "../../recovery/process-lease.js";
import { readCheckpoint as readImplementationCheckpoint } from "../software-change/implementation/checkpoint.js";
import { readDispatchCheckpoint, writeDispatchCheckpoint, type DispatchCheckpoint } from "./state.js";

export type DispatchResumeScope = AsyncDisposable & {
  state: DispatchCheckpoint;
  checkpointFile: string;
};

export async function reconcileDispatchResume(runDir: string): Promise<DispatchResumeScope> {
  const lock = await acquireRunLock(join(runDir, "dispatch.lock"));
  const checkpointFile = join(runDir, "artifacts", "dispatch-state.json");
  try {
    const state = await readDispatchCheckpoint(checkpointFile);
    await writeDispatchCheckpoint(checkpointFile, state);
    await reconcileProcessLeases(join(runDir, "children"));
    const operation = state.operation;
    if (operation && operation.status !== "completed" && operation.status !== "failed") {
      if (operation.failure?.kind === "reconciliation") throw new Error(`dispatch reconciliation required: ${operation.failure.evidence}`);
      try {
        if (operation.type === "implementation/task") await validateImplementationArtifacts(state);
        const expected = operation.repositoryAfter ?? operation.repository;
        const repository = await reconcileRepository(state.repository, expected, operation.id, {
          activeBranch: state.active?.branch,
          allowDirty: expected.tree === "dirty",
        });
        if (repository.recoveryRef) {
          expected.recoveryRef = repository.recoveryRef;
          expected.diffDigest = repository.diffDigest;
        }
      } catch (error) {
        operation.status = "interrupted";
        operation.failure = { kind: "reconciliation", evidence: error instanceof Error ? error.message : String(error) };
        await writeDispatchCheckpoint(checkpointFile, state);
        throw new Error(`dispatch reconciliation required: ${operation.failure.evidence}`);
      }
      operation.status = "recovering";
      await writeDispatchCheckpoint(checkpointFile, state);
    }
    return {
      state,
      checkpointFile,
      async [Symbol.asyncDispose]() { await lock[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await lock[Symbol.asyncDispose]();
    throw error;
  }
}

async function validateImplementationArtifacts(state: DispatchCheckpoint): Promise<void> {
  const active = state.active;
  const operation = state.operation;
  if (!active?.canonicalGraphFile || !active.implementationCheckpointFile || !operation?.implementation) {
    throw new Error("dispatch reconciliation required: active implementation lacks canonical artifact linkage");
  }
  const graph = validateTaskGraph(JSON.parse(await readFile(active.canonicalGraphFile, "utf8")), { repoRoot: state.repository });
  const digest = taskGraphDigest(graph);
  const implementation = await readImplementationCheckpoint(active.implementationCheckpointFile);
  if (active.graphDigest !== digest
    || operation.implementation.graphDigest !== digest
    || implementation.graphDigest !== digest
    || implementation.branch !== active.branch) {
    throw new Error("dispatch reconciliation required: implementation graph or checkpoint identity mismatch");
  }
}
