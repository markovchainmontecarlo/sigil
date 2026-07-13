import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { readProcessIdentity } from "../src/process-identity.js";
import { reconcileProcessLeases, writeProcessLease } from "../src/recovery/process-lease.js";
import { reconcileDispatchResume } from "../src/workflows/dispatch/reconciliation.js";
import { writeDispatchCheckpoint, type DispatchCheckpoint } from "../src/workflows/dispatch/state.js";

function legacyState(repo: string): DispatchCheckpoint {
  return {
    version: 2 as 3,
    repository: repo,
    backlogFile: join(repo, "backlog.json"),
    backlogDigest: "digest",
    deliveryPolicy: "mergeWhenGreen",
    deliveryBase: "main",
    delivered: [{ id: "done", commit: "abc" }],
    active: { id: "active", branch: "sigil/active", taskFile: join(repo, "task.json"), stage: "software-change", issues: [] },
    operation: {
      id: "operation", type: "implementation/task", status: "running", attempt: 1, repairBudget: 3,
      inputArtifact: "input.json", inputDigest: "digest", repository: { branch: "main", tree: "clean" }, gates: {},
    },
  };
}

describe("dispatch resume reconciliation", () => {
  test("only one simultaneous resume owns reconciliation", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dispatch-lock-"));
    const repo = mkdtempSync(join(tmpdir(), "sigil-dispatch-lock-repo-"));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    await writeDispatchCheckpoint(join(runDir, "artifacts", "dispatch-state.json"), {
      version: 3, repository: repo, backlogFile: join(repo, "backlog.json"), backlogDigest: "digest",
      deliveryPolicy: "mergeWhenGreen", deliveryBase: "main", delivered: [],
    });
    await using winner = await reconcileDispatchResume(runDir);
    await expect(reconcileDispatchResume(runDir)).rejects.toThrow("timed out acquiring lock");
    expect(winner.state.delivered).toEqual([]);
  });

  test("run lock is owned before legacy active work is refused and migration preserves delivered evidence", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dispatch-resume-"));
    const repo = mkdtempSync(join(tmpdir(), "sigil-dispatch-repo-"));
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    const state = legacyState(repo);
    await writeDispatchCheckpoint(join(runDir, "artifacts", "dispatch-state.json"), state);

    await expect(reconcileDispatchResume(runDir)).rejects.toThrow("legacy implementation lacks canonical graph");
    const migrated = JSON.parse(await Bun.file(join(runDir, "artifacts", "dispatch-state.json")).text());
    expect(migrated.version).toBe(3);
    expect(migrated.delivered).toEqual([{ id: "done", commit: "abc" }]);
    expect(migrated.operation.failure.kind).toBe("reconciliation");
  });

  test("a live prior owner is protected and a reused child PID is not signalled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-dispatch-leases-"));
    const identity = await readProcessIdentity();
    const liveOwner = join(directory, "live.json");
    await writeProcessLease(liveOwner, { ...identity, ownerIdentity: identity, childKind: "acp", processGroupId: identity.pid });
    await expect(reconcileProcessLeases(directory)).rejects.toThrow("dispatcher owner");

    const reused = join(directory, "reused.json");
    rmSync(liveOwner);
    const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
    child.unref();
    const childIdentity = await readProcessIdentity(child.pid!);
    await writeProcessLease(reused, {
      ...childIdentity, startIdentity: "different-start", ownerIdentity: { pid: 999999, startIdentity: "gone" },
      childKind: "acp", processGroupId: child.pid!,
    });
    try {
      await expect(reconcileProcessLeases(directory)).rejects.toThrow("cannot be signalled safely");
      expect(process.kill(child.pid!, 0)).toBe(true);
      expect(existsSync(reused)).toBe(true);
    } finally {
      process.kill(-child.pid!, "SIGKILL");
    }
  });

  test("an identity-matched child of an abandoned owner exits before reconciliation returns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-dispatch-abandoned-"));
    const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
    child.unref();
    const identity = await readProcessIdentity(child.pid!);
    const lease = join(directory, "child.json");
    await writeProcessLease(lease, {
      ...identity, ownerIdentity: { pid: 999999, startIdentity: "gone" }, childKind: "acp", processGroupId: child.pid!,
    });
    await reconcileProcessLeases(directory);
    expect(existsSync(lease)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("removes dead and reused legacy leases without signalling a process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-dispatch-legacy-leases-"));
    const deadLease = join(directory, "dead.json");
    const reusedLease = join(directory, "reused.json");
    writeFileSync(deadLease, JSON.stringify({
      pid: 999_999,
      startIdentity: "gone",
      heartbeat: "recorded",
    }));
    writeFileSync(reusedLease, JSON.stringify({
      pid: process.pid,
      startIdentity: "different-process-instance",
      heartbeat: "recorded",
    }));

    await reconcileProcessLeases(directory);

    expect(existsSync(deadLease)).toBe(false);
    expect(existsSync(reusedLease)).toBe(false);
  });

  test("preserves a live legacy lease whose ownership cannot be established", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-dispatch-live-legacy-"));
    const lease = join(directory, "live.json");
    const identity = await readProcessIdentity();
    writeFileSync(lease, JSON.stringify({ ...identity, heartbeat: "recorded" }));

    await expect(reconcileProcessLeases(directory)).rejects.toThrow(
      "still alive and its ownership cannot be established",
    );
    expect(existsSync(lease)).toBe(true);
  });

  test("reports a malformed lease without deleting it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-dispatch-malformed-lease-"));
    const lease = join(directory, "malformed.json");
    writeFileSync(lease, JSON.stringify({ pid: "invalid" }));

    await expect(reconcileProcessLeases(directory)).rejects.toThrow("invalid process lease");
    expect(existsSync(lease)).toBe(true);
  });
});
