import { createHash } from "node:crypto";

import { git } from "../git.js";
import type { RepositoryExpectation } from "../workflows/dispatch/state.js";

export type RepositoryState = {
  branch: string;
  head: string;
  dirty: boolean;
  diffDigest: string;
};

export async function readRepositoryState(repo: string): Promise<RepositoryState> {
  const branch = await requiredGit(repo, ["branch", "--show-current"]);
  const head = await requiredGit(repo, ["rev-parse", "HEAD"]);
  const status = await requiredGit(repo, ["status", "--porcelain=v1"]);
  const diff = await requiredGit(repo, ["diff", "--binary", "HEAD"]);
  return {
    branch,
    head,
    dirty: status.length > 0,
    diffDigest: createHash("sha256").update(diff).digest("hex"),
  };
}

export async function createRecoveryRef(repo: string, operationId: string): Promise<string> {
  const committed = await requiredGit(repo, ["stash", "create", "Sigil recovery snapshot"]);
  if (!committed) throw new Error("failed to create recovery snapshot for dirty tracked tree");
  const ref = `refs/sigil/recovery/${operationId}`;
  await requiredGit(repo, ["update-ref", ref, committed]);
  return ref;
}

export async function reconcileRepository(
  repo: string,
  expected: RepositoryExpectation,
  operationId: string,
  options: { activeBranch?: string; allowDirty?: boolean } = {},
): Promise<RepositoryState & { recoveryRef?: string }> {
  const actual = await readRepositoryState(repo);
  const branchAllowed = actual.branch === expected.branch || actual.branch === options.activeBranch;
  if (!branchAllowed) throw new Error(`unexpected branch: expected ${options.activeBranch ?? expected.branch}, found ${actual.branch}`);
  const unchangedBranch = actual.branch === expected.branch;
  if (unchangedBranch && expected.expectedHead && actual.head !== expected.expectedHead) {
    throw new Error(`unexpected commit: expected ${expected.expectedHead}, found ${actual.head}`);
  }
  if (actual.dirty && !options.allowDirty) throw new Error("unexpected dirty working tree; resume refused before mutation");
  if (actual.dirty
    && !options.allowDirty
    && unchangedBranch
    && expected.diffDigest
    && actual.diffDigest !== expected.diffDigest) {
    throw new Error("working-tree changes do not match the interrupted operation");
  }
  if (!actual.dirty) return actual;
  return { ...actual, recoveryRef: await createRecoveryRef(repo, operationId) };
}

async function requiredGit(repo: string, args: string[]): Promise<string> {
  const result = await git(repo, args);
  if (result.code !== 0) throw new Error(result.log || `git ${args[0]} failed`);
  return result.stdout.trim();
}
