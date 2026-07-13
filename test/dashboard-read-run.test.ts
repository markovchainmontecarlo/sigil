import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readProcessIdentity } from "../src/process-identity.js";
import { readRun } from "../src/dashboard/read-run.js";

describe("dashboard run reader", () => {
  test("normalizes a live dispatch and reports progress", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-run-"));
    const artifacts = join(runDir, "artifacts");
    const lock = join(runDir, "dispatch.lock");
    const backlog = join(runDir, "backlog.json");
    const checkpoint = join(artifacts, "implementation.json");
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify(await readProcessIdentity()));
    writeFileSync(backlog, JSON.stringify({
      mission: "Deliver both changes.",
      items: [
        { id: "base", goal: "Deliver the foundation", dependsOn: [] },
        { id: "item", goal: "Deliver the feature", dependsOn: ["base"] },
      ],
    }));
    writeFileSync(checkpoint, JSON.stringify({ tasks: { first: { status: "completed" }, second: { status: "pending" } } }));
    writeFileSync(join(artifacts, "status.json"), JSON.stringify({ at: new Date().toISOString(), stage: "task-started", operationPath: "dispatch/item" }));
    writeFileSync(join(artifacts, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: "task-started", task: "first" })}\n`);
    writeFileSync(join(artifacts, "dispatch-runtime.json"), JSON.stringify({ binding: "codex:model", profile: "pro" }));
    writeFileSync(join(artifacts, "dispatch-state.json"), JSON.stringify({
      version: 3,
      repository: "/repo/project",
      backlogFile: backlog,
      backlogDigest: "digest",
      deliveryPolicy: "integrationBranch",
      deliveryBase: "dev",
      delivered: [{ id: "base" }],
      active: { id: "item", branch: "feature/item", taskFile: "task.json", implementationCheckpointFile: checkpoint, stage: "software-change", issues: [] },
      operation: { id: "operation", type: "implementation/task", status: "running", attempt: 1, repairBudget: 3, inputArtifact: "task.json", inputDigest: "digest", repository: { branch: "feature/item", tree: "clean" }, gates: {} },
    }));

    const run = await readRun(runDir);

    expect(run.health).toEqual({ state: "running", process: "alive" });
    expect(run.backlog).toMatchObject({ completed: 1, total: 2, label: "item" });
    expect(run.backlogWork).toMatchObject({
      goal: "Deliver both changes.",
      tasks: [
        { id: "base", status: "completed" },
        { id: "item", status: "running" },
      ],
    });
    expect(run.tasks).toMatchObject({ completed: 1, total: 2 });
    expect(run.binding).toBe("codex:model");
    expect(run.profile).toBe("pro");
  });

  test("reports incomplete historical artifacts without throwing", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-legacy-"));
    mkdirSync(join(runDir, "artifacts"));
    writeFileSync(join(runDir, "artifacts", "status.json"), "not-json");

    const run = await readRun(runDir);

    expect(run.health.state).toBe("unknown");
    expect(run.warnings.length).toBeGreaterThan(0);
  });

  test("reads task, verification, and failure details from a standalone software change", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-software-change-"));
    const implementation = join(runDir, "artifacts", "implementation");
    mkdirSync(implementation, { recursive: true });
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "failed", message: "repair prompt missing" }));
    writeFileSync(join(implementation, "checkpoint.json"), JSON.stringify({
      tasks: {
        complete: { status: "completed" },
        active: { status: "running" },
        dependent: { status: "blocked" },
      },
    }));
    writeFileSync(join(implementation, "task-graph.json"), JSON.stringify({
      goal: "Show useful workflow progress.",
      tasks: [
        { id: "complete", title: "Complete foundation", dependencies: [] },
        { id: "active", title: "Build dashboard", dependencies: ["complete"] },
        { id: "dependent", title: "Verify dashboard", dependencies: ["active"] },
      ],
    }));
    writeFileSync(join(runDir, "events.jsonl"), [
      JSON.stringify({ at: new Date().toISOString(), stage: "gate-completed", gate: "test", outcome: "failed", exitCode: "1" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "workflow-failed", error: "repair prompt missing" }),
    ].join("\n"));

    const run = await readRun(runDir);

    expect(run.tasks).toMatchObject({ completed: 1, total: 3, active: ["active"], blocked: 1 });
    expect(run.work).toMatchObject({
      goal: "Show useful workflow progress.",
      tasks: [
        { id: "complete", title: "Complete foundation", status: "completed" },
        { id: "active", title: "Build dashboard", status: "running" },
        { id: "dependent", title: "Verify dashboard", status: "blocked" },
      ],
    });
    expect(run.gates).toEqual([{ name: "test", outcome: "failed", exitCode: "1" }]);
    expect(run.failure).toBe("repair prompt missing");
  });

  test("correlates a legacy recorded PID with process start time", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-pid-"));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "running", pid: process.pid }));
    writeFileSync(join(runDir, "events.jsonl"), "");

    const run = await readRun(runDir);

    expect(run.health).toEqual({ state: "running", process: "alive" });
  });

  test("reports the current verification pass instead of stale recovery evidence", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-verification-"));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "running", pid: process.pid }));
    writeFileSync(join(runDir, "events.jsonl"), [
      JSON.stringify({ at: new Date().toISOString(), stage: "gate-completed", gate: "verify", outcome: "failed", exitCode: "1" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "final-verification", attempt: "1", outcome: "failed" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "final-verification", attempt: "2" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "gate-completed", gate: "build", outcome: "passed", exitCode: "0" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "gate-started", gate: "test" }),
    ].join("\n"));

    const run = await readRun(runDir);

    expect(run.activity).toEqual({ label: "Running unit tests", detail: "This verification pass: build passed." });
    expect(run.gates).toEqual([{ name: "build", outcome: "passed", exitCode: "0" }]);
  });

  test("reports review after final verification instead of an older recovery state", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "sigil-dashboard-review-"));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "running", pid: process.pid }));
    writeFileSync(join(runDir, "events.jsonl"), [
      JSON.stringify({ at: new Date().toISOString(), stage: "final-verification", attempt: "2", outcome: "passed" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "agent-started", role: "reviewer" }),
      JSON.stringify({ at: new Date().toISOString(), stage: "agent-capacity", profile: "pro" }),
    ].join("\n"));

    const run = await readRun(runDir);

    expect(run.activity).toEqual({
      label: "Reviewing completed changes",
      detail: "Final verification passed. 0 review operations completed; 1 active.",
    });
    expect(run.events.map((event) => event.stage)).toEqual(["final-verification", "agent-started"]);
  });
});
describe("dashboard dispatch summary", () => {
  test("retains every available task graph and estimates known remaining work", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-dispatch-"));
    const artifacts = join(root, "artifacts");
    const backlogFile = join(root, "backlog.json");
    const completedRoot = join(artifacts, "dispatch", "completed-item");
    const activeRoot = join(artifacts, "dispatch", "active-item");
    mkdirSync(join(completedRoot, "implementation"), { recursive: true });
    mkdirSync(join(activeRoot, "implementation"), { recursive: true });

    writeFileSync(backlogFile, JSON.stringify({
      mission: "Deliver both items.",
      items: [
        { id: "completed-item", goal: "Completed work", dependsOn: [] },
        { id: "active-item", goal: "Active work", dependsOn: ["completed-item"] },
      ],
    }));
    writeFileSync(join(artifacts, "dispatch-state.json"), JSON.stringify({
      version: 3,
      repository: "/repo/example",
      backlogFile,
      backlogDigest: "digest",
      deliveryPolicy: "merge",
      deliveryBase: "main",
      delivered: [{ id: "completed-item", commit: "abc" }],
      active: { id: "active-item", branch: "feature/test", taskFile: "unused", stage: "software-change", issues: [] },
    }));
    writeTaskGraph(completedRoot, ["one", "two"]);
    writeCheckpoint(completedRoot, { one: "completed", two: "completed" });
    writeEvents(completedRoot, [
      event("2026-01-01T00:00:00.000Z", "task-started", "one"),
      event("2026-01-01T00:10:00.000Z", "task-completed", "one"),
      event("2026-01-01T00:20:00.000Z", "task-completed", "two"),
    ]);
    writeTaskGraph(activeRoot, ["three", "four"]);
    writeCheckpoint(activeRoot, { three: "completed", four: "pending" });
    writeEvents(activeRoot, [
      event("2026-01-01T01:00:00.000Z", "task-started", "three"),
      event("2026-01-01T01:10:00.000Z", "task-completed", "three"),
    ]);

    const run = await readRun(root);

    expect(run.dispatch).toMatchObject({
      completedKnownTasks: 3,
      totalKnownTasks: 4,
      estimateBasis: 2,
      unplannedItems: 0,
      estimatedRemainingMs: 600_000,
    });
    expect(run.dispatch?.items.map((item) => [item.id, item.status, item.work?.tasks.length])).toEqual([
      ["completed-item", "completed", 2],
      ["active-item", "running", 2],
    ]);
  });
});

function writeTaskGraph(root: string, ids: string[]): void {
  writeFileSync(join(root, "implementation", "task-graph.json"), JSON.stringify({
    goal: `${ids.length} tasks`,
    tasks: ids.map((id) => ({ id, title: `Task ${id}`, dependencies: [] })),
  }));
}

function writeCheckpoint(root: string, tasks: Record<string, string>): void {
  writeFileSync(join(root, "implementation", "checkpoint.json"), JSON.stringify({
    tasks: Object.fromEntries(Object.entries(tasks).map(([id, status]) => [id, { status }])),
  }));
}

function writeEvents(root: string, events: object[]): void {
  writeFileSync(join(root, "events.jsonl"), `${events.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function event(at: string, stage: string, task: string): object {
  return { at, stage, task };
}
