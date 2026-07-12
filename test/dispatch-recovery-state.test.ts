import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  acquireRunLock,
  assertNoLiveChild,
  reconcileProcessLeases,
  writeProcessLease,
} from "../src/recovery/process-lease.js";
import {
  processGroupHasLiveMembers,
  processIdentityIsAlive,
  processIdentityStatus,
  readProcessIdentity,
  signalProcessGroup,
} from "../src/process-identity.js";
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
      ownerIdentity: identity,
      childKind: "acp",
      processGroupId: identity.pid,
    });
    await expect(assertNoLiveChild(childPath)).rejects.toThrow("may still own");
  });

  test("removes a stale lease when the PID start identity does not match", async () => {
    const childPath = join(mkdtempSync(join(tmpdir(), "sigil-lease-")), "child.json");
    await writeProcessLease(childPath, {
      pid: process.pid,
      startIdentity: "stale-process-instance",
      ownerIdentity: await readProcessIdentity(),
      childKind: "acp",
      processGroupId: process.pid,
    });

    await expect(assertNoLiveChild(childPath)).resolves.toBeUndefined();
  });

  test("reconciles surviving descendants after their group leader exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-descendant-lease-"));
    const leasePath = join(directory, "child.json");
    const leader = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      setTimeout(() => process.exit(0), 100);
    `], { detached: true, stdio: "ignore" });
    if (!leader.pid) throw new Error("leader did not start");
    const identity = await readProcessIdentity(leader.pid);
    await writeProcessLease(leasePath, {
      ...identity,
      ownerIdentity: { pid: 999_999, startIdentity: "gone" },
      childKind: "acp",
      processGroupId: leader.pid,
    });

    try {
      await waitForIdentity(identity, "missing");
      expect(await processGroupHasLiveMembers(leader.pid)).toBe(true);

      await reconcileProcessLeases(directory);

      expect(await processGroupHasLiveMembers(leader.pid)).toBe(false);
      expect(existsSync(leasePath)).toBe(false);
      await expect(reconcileProcessLeases(directory)).resolves.toBeUndefined();
    } finally {
      signalProcessGroup(leader.pid, "SIGKILL");
    }
  });

  test("escalates a TERM-resistant abandoned group before removing its lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-resistant-lease-"));
    const leasePath = join(directory, "child.json");
    const leader = spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: "ignore" });
    if (!leader.pid) throw new Error("leader did not start");
    const identity = await readProcessIdentity(leader.pid);
    await writeProcessLease(leasePath, {
      ...identity,
      ownerIdentity: { pid: 999_999, startIdentity: "gone" },
      childKind: "acp",
      processGroupId: leader.pid,
    });
    const started = Date.now();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await reconcileProcessLeases(directory);

      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      expect(await processGroupHasLiveMembers(leader.pid)).toBe(false);
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      signalProcessGroup(leader.pid, "SIGKILL");
    }
  });

  test("does not signal a reused leader PID or a live dispatcher owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-identity-lease-"));
    const reusedPath = join(directory, "reused.json");
    const ownedPath = join(directory, "owned.json");
    const identity = await readProcessIdentity();
    const reusedLeader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!reusedLeader.pid) throw new Error("reused leader did not start");
    const reusedIdentity = await readProcessIdentity(reusedLeader.pid);
    await writeProcessLease(reusedPath, {
      ...reusedIdentity,
      startIdentity: "different-process-instance",
      ownerIdentity: { pid: 999_999, startIdentity: "gone" },
      childKind: "acp",
      processGroupId: reusedIdentity.pid,
    });

    try {
      await expect(reconcileProcessLeases(directory)).rejects.toThrow("cannot be signalled safely");
      expect(existsSync(reusedPath)).toBe(true);
      expect(await processIdentityIsAlive(reusedIdentity)).toBe(true);
    } finally {
      signalProcessGroup(reusedIdentity.pid, "SIGKILL");
    }

    await writeProcessLease(ownedPath, {
      ...identity,
      ownerIdentity: identity,
      childKind: "acp",
      processGroupId: identity.pid,
    });
    await expect(reconcileProcessLeases(directory)).rejects.toThrow("dispatcher owner");
    expect(existsSync(ownedPath)).toBe(true);
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
    const dirtyExpected = await readRepositoryState(repo);

    await expect(reconcileRepository(repo, {
      branch: expected.branch,
      expectedHead: expected.head,
      tree: "clean",
      diffDigest: dirtyExpected.diffDigest,
    }, "unexpected")).rejects.toThrow("unexpected dirty");
    const recovered = await reconcileRepository(repo, {
      branch: expected.branch,
      expectedHead: expected.head,
      tree: "clean",
      diffDigest: dirtyExpected.diffDigest,
    }, "expected", { activeBranch: expected.branch, allowDirty: true });

    expect(recovered.recoveryRef).toBe("refs/sigil/recovery/expected");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("file.txt");
  });
});

async function waitForIdentity(
  identity: Awaited<ReturnType<typeof readProcessIdentity>>,
  status: Awaited<ReturnType<typeof processIdentityStatus>>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await processIdentityStatus(identity) !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await processIdentityStatus(identity)).toBe(status);
}
