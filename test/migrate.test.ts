import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import type { SigilAgent } from "../src/agents.js";
import { createContext } from "../src/context.js";
import {
  migrate,
  orderMigrationItems,
  parseMigrationBacklog,
} from "../src/workflows/migrate/index.js";

type MigrationAgentState = {
  refactorReviewFailures?: number;
  migrationReviewCalls?: number;
  migrationFindings?: string[];
};

class MigrationAgent implements SigilAgent {
  constructor(
    private readonly repo: string,
    private readonly state: MigrationAgentState = {},
  ) {}

  async prompt<T>(prompt: string, schema?: z.ZodType<T>): Promise<string | T> {
    if (schema && prompt.includes("Create a small ordered refactor plan")) {
      return schema.parse({
        goal: "Move the fixture to its target structure.",
        invariants: ["app.txt remains readable"],
        slices: [{
          id: "move-app",
          description: "Update the fixture.",
          paths: ["app.txt"],
          expectedChange: "The fixture records the migration.",
        }],
      });
    }
    if (schema && prompt.includes("completed repository migration")) {
      const call = this.state.migrationReviewCalls ?? 0;
      this.state.migrationReviewCalls = call + 1;
      const round = Math.floor(call / 2);
      const finding = this.state.migrationFindings?.[round];
      return schema.parse({
        blocking: Boolean(finding),
        findings: finding
          ? [{ id: finding, severity: "high", evidence: finding, requiredChange: finding }]
          : [],
      });
    }
    if (schema && (this.state.refactorReviewFailures ?? 0) > 0) {
      this.state.refactorReviewFailures!--;
      throw new Error("schema prompt failed: requiredChange missing");
    }
    if (schema) return schema.parse({ blocking: false, findings: [] });
    if (prompt.includes("Apply this refactor slice now")) {
      const path = prompt.includes("Discover a required caller automatically")
        ? "shared.txt"
        : prompt.includes("Implement the second item")
          ? "second.txt"
          : "app.txt";
      writeFileSync(join(this.repo, path), "migrated\n");
      return `Updated ${path}.`;
    }
    return "Grounded analysis.";
  }

  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "sigil-migrate-test-"));
  writeFileSync(join(repo, "app.txt"), "original\n");
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: {
      analyst: { provider: "codex", model: "gpt-5.5", effort: "medium" },
      coder: { provider: "codex", model: "gpt-5.5", effort: "medium" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "medium" },
    },
    evals: { build: "test -s app.txt", test: "test -s app.txt" },
    context: [],
    plan: { planners: ["analyst", "reviewer"], synthesizer: "analyst", reviewer: "analyst", semanticReviewLimit: 2 },
    implement: {
      coder: "coder",
      sessionTaskLimit: 5,
      repairLimit: 1,
      branchPrefix: "sigil/",
      baseBranch: "main",
    },
    review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
  }, null, 2));
  git(repo, ["init", "-b", "migration/test"]);
  git(repo, ["config", "user.name", "Sigil Test"]);
  git(repo, ["config", "user.email", "sigil@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

describe("migration workflow", () => {
  test("orders dependencies and rejects unknown references", () => {
    const backlog = parseMigrationBacklog({
      contractVersion: 1,
      goal: "Migrate the fixture.",
      items: [
        { id: "second", intent: "Second", brief: "Second", focus: ["b"], dependsOn: ["first"], commitMessage: "Second" },
        { id: "first", intent: "First", brief: "First", focus: ["a"], commitMessage: "First" },
      ],
    });

    expect(orderMigrationItems(backlog.items).map((item) => item.id)).toEqual(["first", "second"]);
    expect(() => parseMigrationBacklog({
      contractVersion: 1,
      goal: "Invalid",
      items: [{ id: "item", intent: "Item", brief: "Item", focus: ["a"], dependsOn: ["missing"], commitMessage: "Item" }],
    })).toThrow("unknown dependency");
  });

  test("refactors, commits, reviews, checkpoints, and resumes", async () => {
    const repo = fixtureRepo();
    const runDir = mkdtempSync(join(tmpdir(), "sigil-migrate-run-"));
    const targetFile = join(runDir, "target.md");
    const backlogFile = join(runDir, "backlog.json");
    writeFileSync(targetFile, "app.txt records the migrated state.\n");
    writeFileSync(backlogFile, JSON.stringify({
      contractVersion: 1,
      goal: "Migrate the fixture.",
      items: [{
        id: "app",
        intent: "Update the app fixture without changing readability.",
        brief: "Keep app.txt non-empty.",
        focus: ["app.txt"],
        commitMessage: "Migrate app fixture",
      }],
    }));
    const ctx = createContext(repo, {
      createAgent: () => new MigrationAgent(repo),
      artifactRoot: join(runDir, "artifacts"),
    });

    const result = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);

    expect(result.valid).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].commit).toBe(result.head);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("migrated\n");
    expect(JSON.parse(readFileSync(result.stateFile, "utf8")).completed).toHaveLength(1);
    expect(readFileSync(result.eventsFile, "utf8")).toContain('"stage":"completed"');

    const resumed = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);
    expect(resumed.valid).toBe(true);
    expect(resumed.items).toEqual([]);
    expect(resumed.head).toBe(result.head);
  });

  test("records dependency discovery and advances to the next item without restarting", async () => {
    const repo = fixtureRepo();
    const runDir = mkdtempSync(join(tmpdir(), "sigil-migrate-recovery-"));
    const targetFile = join(runDir, "target.md");
    const backlogFile = join(runDir, "backlog.json");
    writeFileSync(targetFile, "Complete both migration items.\n");
    writeFileSync(backlogFile, JSON.stringify({
      contractVersion: 1,
      goal: "Recover and continue.",
      items: [
        {
          id: "first",
          intent: "Discover a required caller automatically.",
          brief: "A required caller may be discovered.",
          focus: ["app.txt"],
          commitMessage: "Complete first item",
        },
        {
          id: "second",
          intent: "Implement the second item.",
          brief: "Continue after the recovered first item.",
          focus: ["second.txt"],
          dependsOn: ["first"],
          commitMessage: "Complete second item",
        },
      ],
    }));
    const ctx = createContext(repo, {
      createAgent: () => new MigrationAgent(repo),
      artifactRoot: join(runDir, "artifacts"),
    });

    const result = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);
    const state = JSON.parse(readFileSync(result.stateFile, "utf8"));

    expect(result.valid).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(state.completed).toHaveLength(2);
    expect(state.discoveries.first.map((entry: { path: string }) => entry.path)).toEqual(["shared.txt"]);
    expect(readFileSync(result.eventsFile, "utf8")).not.toContain('"stage":"item-recovery"');
  });

  test("isolates failed item evidence and restores the verified checkpoint", async () => {
    const repo = fixtureRepo();
    const runDir = mkdtempSync(join(tmpdir(), "sigil-migrate-failure-"));
    const targetFile = join(runDir, "target.md");
    const backlogFile = join(runDir, "backlog.json");
    writeFileSync(targetFile, "app.txt records the migrated state.\n");
    writeFileSync(backlogFile, JSON.stringify({
      contractVersion: 1,
      goal: "Migrate the fixture.",
      items: [{
        id: "app",
        intent: "Update the app fixture.",
        brief: "Keep app.txt readable.",
        focus: ["app.txt"],
        commitMessage: "Migrate app fixture",
      }],
    }));
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const state: MigrationAgentState = { refactorReviewFailures: 10 };
    const ctx = createContext(repo, {
      createAgent: () => new MigrationAgent(repo, state),
      artifactRoot: join(runDir, "runtime"),
    });

    const result = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);

    expect(result.valid).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim()).toBe(originalHead);
    expect(execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    })).toBe("");
    const attempt = join(runDir, "items", "app", "attempt-1");
    expect(existsSync(join(attempt, "failure.json"))).toBe(true);
    expect(readFileSync(join(attempt, "diff.patch"), "utf8")).toContain("migrated");
    expect(readdirSync(join(runDir, "items", "app"))).toEqual(["attempt-1"]);
  });

  test("reconciles a committed item when state persistence was interrupted", async () => {
    const repo = fixtureRepo();
    const runDir = mkdtempSync(join(tmpdir(), "sigil-migrate-checkpoint-"));
    const targetFile = join(runDir, "target.md");
    const backlogFile = join(runDir, "backlog.json");
    writeFileSync(targetFile, "app.txt records the migrated state.\n");
    writeFileSync(backlogFile, JSON.stringify({
      contractVersion: 1,
      goal: "Migrate the fixture.",
      items: [{
        id: "app",
        intent: "Update the app fixture.",
        brief: "Keep app.txt readable.",
        focus: ["app.txt"],
        commitMessage: "Migrate app fixture",
      }],
    }));
    const ctx = createContext(repo, {
      createAgent: () => new MigrationAgent(repo),
      artifactRoot: join(runDir, "runtime"),
    });
    const first = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);
    const stateFile = join(runDir, "state.json");
    const interruptedState = JSON.parse(readFileSync(stateFile, "utf8"));
    interruptedState.completed = [];
    interruptedState.discoveries = {};
    interruptedState.finalVerified = false;
    writeFileSync(stateFile, `${JSON.stringify(interruptedState, null, 2)}\n`);
    unlinkSync(join(runDir, "items", "app", "attempt-1", "checkpoint.json"));

    const resumed = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);

    expect(resumed.valid).toBe(true);
    expect(resumed.items).toEqual([]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).completed).toEqual([{
      id: "app",
      commit: first.head,
    }]);
  });

  test("gives new repository-wide findings independent repair budgets", async () => {
    const repo = fixtureRepo();
    const runDir = mkdtempSync(join(tmpdir(), "sigil-migrate-final-review-"));
    const targetFile = join(runDir, "target.md");
    const backlogFile = join(runDir, "backlog.json");
    writeFileSync(targetFile, "app.txt records the migrated state.\n");
    writeFileSync(backlogFile, JSON.stringify({
      contractVersion: 1,
      goal: "Migrate the fixture.",
      items: [{
        id: "app",
        intent: "Update the app fixture.",
        brief: "Keep app.txt readable.",
        focus: ["app.txt"],
        commitMessage: "Migrate app fixture",
      }],
    }));
    const state: MigrationAgentState = {
      migrationFindings: ["finding-a", "finding-b", "finding-c"],
    };
    const ctx = createContext(repo, {
      createAgent: () => new MigrationAgent(repo, state),
      artifactRoot: join(runDir, "runtime"),
    });

    const result = await migrate({ repo, targetFile, backlogFile, runDir }, ctx);

    expect(result.valid).toBe(true);
    expect(state.migrationReviewCalls).toBe(8);
    expect(existsSync(join(runDir, "final", "round-4-architecture-review.json"))).toBe(true);
  });

  test("diagram documents checkpoint, attempt, and final verification boundaries", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/migrate/workflow.mermaid"), "utf8");

    expect(diagram).toContain("create item-owned attempt directory and fork context");
    expect(diagram).toContain("persist failed diff and attempt evidence");
    expect(diagram).toContain("restore preceding verified checkpoint");
    expect(diagram).toContain("write pending checkpoint journal");
    expect(diagram).toContain("configured reviewer role runs architecture and behavior reviews in parallel");
    expect(diagram).toContain("write finalVerified state atomically");
  });
});
