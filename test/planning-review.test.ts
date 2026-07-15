import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { loadConfig } from "../src/config.js";
import { CONTRACT_VERSION } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import {
  reviewPlanningGraph,
  summarizePlanningReview,
} from "../src/workflows/software-change/planning/review.js";

const ADVISORY_REPORT = `# Planning review

## HIGH

None.

## MEDIUM

### optional-browser-state

Tasks: task-a

Evidence: The browser scenario covers the primary outcome.

Defect: An optional state is not covered.

Required change: Consider separate component coverage.

## LOW

None.
`;

const HIGH_REPORT = `# Planning review

## HIGH

### missing-required-outcome

Tasks: task-a

Evidence: The brief requires the fixture to change.

Defect: No task changes the fixture.

Required change: Make task-a own the fixture change.

## MEDIUM

None.

## LOW

None.
`;

function graph(architecture = "Initial architecture") {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "review-fixture",
    goal: "Review a graph",
    architecture,
    constraints: [],
    nonGoals: [],
    tasks: [{
      id: "task-a",
      title: "Task A",
      summary: "Change the fixture",
      dependencies: [],
      interfaces: { produces: [], consumes: [] },
      acceptanceCriteria: ["The fixture changes"],
      verification: [{ kind: "command", command: "true", expected: "success" }],
      diagrams: [],
      files: [],
    }],
  };
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "sigil-planning-review-"));
  const taskFile = join(repo, "task-graph.json");
  writeFileSync(taskFile, JSON.stringify(graph()));
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: {
      reviewer: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
    },
    evals: {},
    plan: { planners: ["reviewer"], synthesizer: "reviewer", reviewer: "reviewer" },
    implement: { coder: "reviewer", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "test/", baseBranch: "main" },
    review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
  }));
  return { repo, taskFile };
}

function targetPath(prompt: string): string {
  const match = prompt.match(/(\/[^\s`]+\.(?:md|json))/);
  if (!match?.[1]) throw new Error("missing artifact target");
  return match[1];
}

function reviewInput(repo: string, taskFile: string) {
  return {
    repo,
    intent: "Review a graph",
    brief: "The fixture must change.",
    taskFile,
    crosswalk: "The goal maps to task-a",
    contract: "task graph contract",
    rubric: "planning rubric",
    config: loadConfig(repo),
  };
}

describe("planning review", () => {
  test("summarizes high, medium, and low Markdown sections", () => {
    expect(summarizePlanningReview(ADVISORY_REPORT)).toEqual({
      high: 0,
      medium: 1,
      low: 0,
    });
  });

  test("records medium and low findings without editing or blocking", async () => {
    const { repo, taskFile } = fixture();
    const calls: string[] = [];
    const reviewer = {
      prompt: async (prompt: string) => {
        calls.push(prompt);
        const path = targetPath(prompt);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ADVISORY_REPORT);
        return "";
      },
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    } as SigilAgent;
    const context = createContext(repo, { createAgent: () => reviewer });

    const result = await reviewPlanningGraph(
      context,
      reviewInput(repo, taskFile),
    );

    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ high: 0, medium: 1, low: 0 });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(taskFile, "utf8")).architecture)
      .toBe("Initial architecture");
  });

  test("uses one agent to report once and repair only high findings", async () => {
    const { repo, taskFile } = fixture();
    const calls: string[] = [];
    const bindings: string[] = [];
    const reviewer = {
      prompt: async (prompt: string) => {
        calls.push(prompt);
        const path = targetPath(prompt);
        mkdirSync(dirname(path), { recursive: true });
        if (path.endsWith("review.md")) {
          writeFileSync(path, HIGH_REPORT);
        } else {
          writeFileSync(path, JSON.stringify(graph("Reviewed architecture")));
        }
        return "";
      },
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    } as SigilAgent;
    const context = createContext(repo, {
      createAgent: (binding) => {
        bindings.push(binding as string);
        return reviewer;
      },
    });

    const result = await reviewPlanningGraph(
      context,
      reviewInput(repo, taskFile),
    );

    expect(result.issues).toEqual([]);
    expect(result.summary.high).toBe(1);
    expect(bindings).toEqual(["reviewer"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Repair only the HIGH findings");
    expect(JSON.parse(readFileSync(taskFile, "utf8")).architecture)
      .toBe("Reviewed architecture");
  });
});
