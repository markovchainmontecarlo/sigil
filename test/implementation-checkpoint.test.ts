import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { CONTRACT_VERSION, canonicalTaskGraph, taskGraphDigest, type TaskGraph } from "../src/contracts/task-graph.js";
import {
  captureRecoveryBundle,
  discardTaskWork,
  newCheckpoint,
  nextRunnable,
  reevaluateBlocked,
  restoreRecoveryBundle,
  writeAtomicJson,
} from "../src/workflows/software-change/implementation/checkpoint.js";

function graph(): TaskGraph {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "checkpoint",
    tasks: [
      { id: "a", title: "A", summary: "A", dependencies: [], acceptanceCriteria: ["a"], diagrams: [], files: [] },
      { id: "b", title: "B", summary: "B", dependencies: ["a"], acceptanceCriteria: ["b"], diagrams: [], files: [] },
      { id: "c", title: "C", summary: "C", dependencies: [], acceptanceCriteria: ["c"], diagrams: [], files: [] },
    ],
  };
}

function repository(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "sigil-implementation-checkpoint-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  return { repo, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

describe("implementation checkpoint", () => {
  test("semantic graph identity ignores textual JSON formatting", () => {
    const value = graph();
    const reformatted = JSON.parse(JSON.stringify(value, null, 4)) as TaskGraph;
    expect(canonicalTaskGraph(reformatted)).toBe(canonicalTaskGraph(value));
    expect(taskGraphDigest(reformatted)).toBe(taskGraphDigest(value));
  });

  test("blocked tasks return to pending and independent work stays runnable in canonical order", () => {
    const value = graph();
    const checkpoint = newCheckpoint(value, taskGraphDigest(value), "impl/checkpoint", "main", "base");
    expect(nextRunnable(value, checkpoint)).toBe("a");
    checkpoint.tasks.a.status = "failed";
    reevaluateBlocked(value, checkpoint);
    expect(checkpoint.tasks.b.status).toBe("blocked");
    expect(nextRunnable(value, checkpoint)).toBe("c");
    checkpoint.tasks.a.status = "completed";
    checkpoint.tasks.c.status = "completed";
    reevaluateBlocked(value, checkpoint);
    expect(checkpoint.tasks.b.status).toBe("pending");
  });

  test("atomic checkpoint writes leave a readable complete document", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sigil-checkpoint-write-")), "state.json");
    const checkpoint = newCheckpoint(graph(), taskGraphDigest(graph()), "impl/checkpoint", "main", "base");
    await Promise.all([writeAtomicJson(path, checkpoint), writeAtomicJson(path, checkpoint)]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(checkpoint);
  });

  test("recovery bundles restore tracked and untracked work and reject identity mismatch before mutation", async () => {
    const { repo, head } = repository();
    const identity = { graphDigest: taskGraphDigest(graph()), branch: "main", baseBranch: "main", baselineCommit: head, taskId: "a", taskBase: head };
    writeFileSync(join(repo, "tracked.txt"), "after\n");
    writeFileSync(join(repo, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    const bundle = await captureRecoveryBundle(repo, join(repo, ".git", "bundle"), identity);
    await discardTaskWork(repo, head);

    await expect(restoreRecoveryBundle(repo, bundle, { ...identity, graphDigest: "wrong" })).rejects.toThrow("identity");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("before\n");
    await restoreRecoveryBundle(repo, bundle, identity);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("after\n");
    expect([...readFileSync(join(repo, "untracked.bin"))]).toEqual([0, 1, 2, 255]);
  });
});
