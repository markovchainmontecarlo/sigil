import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { loadConfig } from "../src/config.js";
import { CONTRACT_VERSION } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import {
  convergePlanningReview,
  PlanningReviewOutputSchema,
  type PlanningReviewFinding,
} from "../src/workflows/software-change/planning/review.js";

const finding = (category: PlanningReviewFinding["category"]): PlanningReviewFinding => ({
  category,
  taskIds: ["task-a"],
  evidence: "src/a.ts defines the current boundary",
  rule: "Every dependency has an explicit interface",
  correction: "Name the output consumed by task-a",
});

describe("planning review contract", () => {
  test("accepts every supported semantic finding category", () => {
    const categories: PlanningReviewFinding["category"][] = [
      "missing-requirement",
      "placeholder",
      "task-too-broad",
      "task-too-small",
      "missing-dependency",
      "interface-conflict",
      "undefined-symbol",
      "incorrect-file",
      "unverifiable-criterion",
      "missing-test-coverage",
      "unnecessary-scope",
      "stale-anchor",
    ];

    const parsed = PlanningReviewOutputSchema.parse({ valid: false, findings: categories.map(finding) });

    expect(parsed.findings.map((entry) => entry.category)).toEqual(categories);
  });

  test("requires findings and validity to agree and rejects replacement graphs", () => {
    expect(() => PlanningReviewOutputSchema.parse({ valid: true, findings: [finding("placeholder")] })).toThrow();
    expect(() => PlanningReviewOutputSchema.parse({ valid: false, findings: [] })).toThrow();
    expect(() => PlanningReviewOutputSchema.parse({ valid: false, findings: [finding("placeholder")], taskGraph: {} })).toThrow();
  });

  test("runs fresh review, bounded synthesis repair, deterministic validation, and rereview", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-planning-review-"));
    const taskFile = join(repo, "task-graph.json");
    const graph = {
      contractVersion: CONTRACT_VERSION,
      project: "review-fixture",
      goal: "Review a graph",
      architecture: "Initial architecture",
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
    writeFileSync(taskFile, JSON.stringify(graph));
    writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
      agents: {
        reviewer: { provider: "codex", model: "test-model", effort: "medium" },
        synthesizer: { provider: "codex", model: "test-model", effort: "medium" },
      },
      evals: {},
      plan: { planners: ["synthesizer"], synthesizer: "synthesizer", reviewer: "reviewer", semanticReviewLimit: 1 },
      implement: { coder: "synthesizer", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "test/", baseBranch: "main" },
      review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
    }));

    let reviewCalls = 0;
    const bindings: string[] = [];
    const events: string[] = [];
    const reviewer = {
      prompt: async () => ++reviewCalls === 1
        ? { valid: false, findings: [finding("placeholder")] }
        : { valid: true, findings: [] },
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    } as unknown as SigilAgent;
    const synthesizer = {
      prompt: async () => {
        writeFileSync(taskFile, JSON.stringify({ ...graph, architecture: "Reviewed architecture" }));
        return "";
      },
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    } as unknown as SigilAgent;
    const context = createContext(repo, {
      createAgent: (binding) => {
        bindings.push(binding as string);
        return binding === "reviewer" ? reviewer : synthesizer;
      },
      onObserve: async (stage) => { events.push(stage); },
    });

    const result = await convergePlanningReview(context, {
      repo,
      intent: "Review a graph",
      brief: "",
      taskFile,
      crosswalk: "The goal maps to task-a",
      contract: "task graph contract",
      rubric: "planning rubric",
      config: loadConfig(repo),
    });

    expect(result.issues).toEqual([]);
    expect(result.checked.graph?.architecture).toBe("Reviewed architecture");
    expect(bindings).toEqual(["reviewer", "synthesizer", "reviewer"]);
    expect(events).toContain("planning-review-repair-completed");
  });
});
