import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { acquireRunLock, assertNoLiveChild, writeProcessLease } from "../src/recovery/process-lease.js";
import { readProcessIdentity } from "../src/process-identity.js";
import { readRepositoryState, reconcileRepository } from "../src/recovery/git-snapshot.js";
import {
  loadDispatchCheckpoint,
  startDispatchOperation,
  writeDispatchCheckpoint,
} from "../src/workflows/dispatch/state.js";

describe("dispatch durable recovery state", () => {
  test("rejects a resumed run with a mismatched repository before mutation", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sigil-state-")), "state.json");
    const identity = {
      repository: "/repo/a",
      backlogFile: "/repo/a/backlog.json",
      backlogDigest: "digest",
      deliveryPolicy: "mergeWhenGreen",
      deliveryBase: "main",
    };
    const state = await loadDispatchCheckpoint(path, identity);
    await writeDispatchCheckpoint(path, state);

    await expect(loadDispatchCheckpoint(path, { ...identity, repository: "/repo/b" }))
      .rejects.toThrow("different repository");
  });

  test("persists write-ahead operation identity and immutable input digest", () => {
    const operation = startDispatchOperation({
      type: "review/synthesis",
      inputArtifact: "reviewers.json",
      input: { reports: ["a", "b"] },
      repository: { branch: "feature", expectedHead: "abc", tree: "clean" },
      repairBudget: 3,
    });

    expect(operation.status).toBe("running");
    expect(operation.inputDigest).toHaveLength(64);
    expect(operation.repository.expectedHead).toBe("abc");
  });

  test("exclusive run lock and live child lease prevent a second writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-lease-"));
    const lockPath = join(root, "dispatch.lock");
    const childPath = join(root, "child.json");
    await using _lock = await acquireRunLock(lockPath);

    await expect(acquireRunLock(lockPath)).rejects.toThrow("timed out acquiring lock");
    const identity = await readProcessIdentity();
    await writeProcessLease(childPath, {
      ...identity,
      heartbeat: new Date().toISOString(),
    });
    await expect(assertNoLiveChild(childPath)).rejects.toThrow("may still own");
  });

  test("removes a stale lease when the PID start identity does not match", async () => {
    const childPath = join(mkdtempSync(join(tmpdir(), "sigil-lease-")), "child.json");
    await writeProcessLease(childPath, {
      pid: process.pid,
      startIdentity: "stale-process-instance",
      heartbeat: new Date().toISOString(),
    });

    await expect(assertNoLiveChild(childPath)).resolves.toBeUndefined();
  });

  test("snapshots expected dirty active work and blocks unexpected dirty state", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-reconcile-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    const expected = await readRepositoryState(repo);
    writeFileSync(join(repo, "file.txt"), "in progress\n");

    await expect(reconcileRepository(repo, {
      branch: expected.branch,
      expectedHead: expected.head,
      tree: "clean",
      diffDigest: expected.diffDigest,
    }, "unexpected")).rejects.toThrow("unexpected dirty");
    const recovered = await reconcileRepository(repo, {
      branch: expected.branch,
      expectedHead: expected.head,
      tree: "clean",
      diffDigest: expected.diffDigest,
    }, "expected", { activeBranch: expected.branch, allowDirty: true });

    expect(recovered.recoveryRef).toBe("refs/sigil/recovery/expected");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("file.txt");
  });
});
