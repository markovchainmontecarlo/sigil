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

function baseline() {
  return {
    verification: {
      ok: true,
      gates: [],
      evidence: "baseline passed",
    },
  };
}

function graph(): TaskGraph {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "checkpoint",
    goal: "Verify checkpoint behavior",
    architecture: "Checkpoint state follows the task dependency graph.",
    constraints: [],
    nonGoals: [],
    tasks: [
      { id: "a", title: "A", summary: "A", dependencies: [], interfaces: { produces: [{ name: "a-result", description: "A result" }], consumes: [] }, acceptanceCriteria: ["a"], verification: [{ kind: "command", command: "true", expected: "success" }], diagrams: [], files: [] },
      { id: "b", title: "B", summary: "B", dependencies: ["a"], interfaces: { produces: [], consumes: [{ taskId: "a", name: "a-result", description: "Uses A" }] }, acceptanceCriteria: ["b"], verification: [{ kind: "command", command: "true", expected: "success" }], diagrams: [], files: [] },
      { id: "c", title: "C", summary: "C", dependencies: [], interfaces: { produces: [], consumes: [] }, acceptanceCriteria: ["c"], verification: [{ kind: "command", command: "true", expected: "success" }], diagrams: [], files: [] },
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

  test("graph planning context, interfaces, and verification participate in identity", () => {
    const value = graph();
    const architecture = { ...value, architecture: "A different architecture" };
    const interfaces = {
      ...value,
      tasks: value.tasks.map((task) => task.id === "a"
        ? { ...task, interfaces: { ...task.interfaces, produces: [{ name: "a-result", description: "A different result contract" }] } }
        : task),
    };
    const verification = {
      ...value,
      tasks: value.tasks.map((task) => task.id === "c"
        ? { ...task, verification: [{ kind: "command" as const, command: "false", expected: "failure" }] }
        : task),
    };

    expect(taskGraphDigest(architecture)).not.toBe(taskGraphDigest(value));
    expect(taskGraphDigest(interfaces)).not.toBe(taskGraphDigest(value));
    expect(taskGraphDigest(verification)).not.toBe(taskGraphDigest(value));
  });

  test("blocked tasks return to pending and independent work stays runnable in canonical order", () => {
    const value = graph();
    const checkpoint = newCheckpoint(value, taskGraphDigest(value), "impl/checkpoint", "main", "base", baseline());
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
    const checkpoint = newCheckpoint(graph(), taskGraphDigest(graph()), "impl/checkpoint", "main", "base", baseline());
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
