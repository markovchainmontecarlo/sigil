import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import type { SigilAgent } from "../src/agents.js";
import { createContext } from "../src/context.js";
import { refactor } from "../src/workflows/refactor/index.js";

type AgentState = {
  addUntracked?: boolean;
  blockingFirstReview?: boolean;
  sequentialReviewFindings?: string[];
  sequentialReviewIds?: string[];
  planFailures?: number;
  reviewFailures?: number;
  reviewCalls: number;
  repairRan: boolean;
  prompts: string[];
};

class RefactorAgent implements SigilAgent {
  constructor(
    private readonly repo: string,
    private readonly state: AgentState,
  ) {}

  async prompt<T>(prompt: string, schema?: z.ZodType<T>): Promise<string | T> {
    this.state.prompts.push(prompt);
    if (schema && prompt.includes("Create a small ordered refactor plan")) {
      if ((this.state.planFailures ?? 0) > 0) {
        this.state.planFailures!--;
        throw new Error("schema prompt failed: slice ids missing");
      }
      return schema.parse({
        goal: "Move app behavior behind a clearer module boundary.",
        invariants: ["app.txt remains readable"],
        slices: [{
          id: "move-app",
          description: "Update the app fixture.",
          paths: ["app.txt"],
          expectedChange: "The fixture records the refactor.",
          fastCheck: "test -s app.txt",
        }],
        finalChecks: ["build", "test"],
      });
    }
    if (schema) {
      if ((this.state.reviewFailures ?? 0) > 0) {
        this.state.reviewFailures!--;
        throw new Error("schema prompt failed: requiredChange missing");
      }
      this.state.reviewCalls++;
      const reviewRound = Math.floor((this.state.reviewCalls - 1) / 2);
      const sequentialFinding = this.state.sequentialReviewFindings?.[reviewRound];
      const structureReview = prompt.includes("ownership and dependency direction");
      const blocking = Boolean(
        (this.state.blockingFirstReview && this.state.reviewCalls <= 2)
        || (structureReview && sequentialFinding),
      );
      return schema.parse({
        blocking,
        findings: blocking
          ? [{
            severity: "high",
            id: this.state.sequentialReviewIds?.[reviewRound],
            evidence: sequentialFinding ?? "repair required",
            requiredChange: sequentialFinding ?? "repair it",
          }]
          : [],
      });
    }
    if (prompt.includes("Apply this refactor slice now")) {
      writeFileSync(join(this.repo, "app.txt"), "refactored\n");
      if (this.state.addUntracked) {
        writeFileSync(join(this.repo, "new-module.txt"), "untracked content\n");
      }
      return "Updated app.txt.";
    }
    if (prompt.includes("Repair the blocking review findings")) {
      this.state.repairRan = true;
      return "Repaired review findings.";
    }
    return "Grounded analysis.";
  }

  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "sigil-refactor-test-"));
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
    implement: { coder: "coder", sessionTaskLimit: 5, repairLimit: 1, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
  }, null, 2));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Sigil Test"]);
  git(repo, ["config", "user.email", "sigil@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

describe("refactor workflow", () => {
  test("analyzes, changes, reviews, and validates a clean repository", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Improve the app module structure without changing behavior.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(true);
    expect(result.changedFiles).toEqual(["app.txt"]);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("refactored\n");
    expect(JSON.parse(readFileSync(result.planFile, "utf8")).slices).toHaveLength(1);
    expect(JSON.parse(readFileSync(result.structureReviewFile, "utf8")).blocking).toBe(false);
    expect(JSON.parse(readFileSync(result.behaviorReviewFile, "utf8")).blocking).toBe(false);
    expect(readFileSync(result.eventsFile, "utf8")).toContain('"stage":"completed"');
  });

  test("includes untracked files in review and re-reviews after repair", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      addUntracked: true,
      blockingFirstReview: true,
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Introduce a module without changing behavior.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(true);
    expect(result.discoveries.map((entry) => entry.path)).toContain("new-module.txt");
    expect(state.repairRan).toBe(true);
    expect(state.reviewCalls).toBe(4);
    expect(state.prompts.filter((prompt) => prompt.includes("untracked content"))).toHaveLength(4);
  });

  test("returns structured authority evidence after protected-path repair is exhausted", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      addUntracked: true,
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Change only app.txt.",
      focus: ["app.txt"],
      protectedPaths: ["new-module.txt"],
    }, ctx);

    expect(result.valid).toBe(false);
    expect(result.failures.some((failure) =>
      !failure.recoverable && failure.kind === "authority" && failure.paths?.includes("new-module.txt"),
    )).toBe(true);
  });

  test("gives each newly discovered review finding its own repair budget", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      sequentialReviewFindings: ["finding-a", "finding-b", "finding-c", "finding-d"],
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Keep repairing independently discovered findings.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(true);
    expect(state.reviewCalls).toBe(10);
    expect(state.prompts.filter((prompt) =>
      prompt.includes("Repair the blocking review findings"),
    )).toHaveLength(4);
  });

  test("stops when one finding exhausts its local repair budget", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      sequentialReviewFindings: ["persistent-finding", "persistent-finding"],
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Stop only the unresolved local finding.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(false);
    expect(result.failures.some((failure) =>
      failure.kind === "review" && !failure.recoverable,
    )).toBe(true);
    expect(state.reviewCalls).toBe(4);
  });

  test("uses stable finding ids across reviewer paraphrases", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      sequentialReviewFindings: ["first wording", "different wording"],
      sequentialReviewIds: ["same-boundary-defect", "same-boundary-defect"],
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    const ctx = createContext(repo, {
      createAgent: () => new RefactorAgent(repo, state),
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Track one defect across fresh review wording.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(false);
    expect(state.reviewCalls).toBe(4);
  }, 15_000);

  test("retries plan synthesis in a fresh agent context", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      planFailures: 1,
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    let agents = 0;
    const ctx = createContext(repo, {
      createAgent: () => {
        agents++;
        return new RefactorAgent(repo, state);
      },
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Recover invalid structured plans.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(true);
    expect(result.failures.some((failure) =>
      failure.stage === "plan-synthesis" && failure.recoverable,
    )).toBe(true);
    expect(readFileSync(result.eventsFile, "utf8")).toContain("plan-synthesis-retrying");
    expect(agents).toBeGreaterThanOrEqual(8);
  });

  test("retries each failed reviewer independently in a fresh context", async () => {
    const repo = fixtureRepo();
    const state: AgentState = {
      reviewFailures: 1,
      reviewCalls: 0,
      repairRan: false,
      prompts: [],
    };
    let agents = 0;
    const ctx = createContext(repo, {
      createAgent: () => {
        agents++;
        return new RefactorAgent(repo, state);
      },
      artifactRoot: mkdtempSync(join(tmpdir(), "sigil-refactor-artifacts-")),
    });

    const result = await refactor({
      repo,
      intent: "Recover malformed independent review output.",
      focus: ["app.txt"],
    }, ctx);

    expect(result.valid).toBe(true);
    expect(result.failures.some((failure) =>
      failure.stage.startsWith("review:") && failure.recoverable,
    )).toBe(true);
    expect(state.reviewCalls).toBe(2);
    expect(agents).toBeGreaterThanOrEqual(8);
  });

  test("diagram documents refactor gates, operation recovery, and review convergence", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/refactor/workflow.mermaid"), "utf8");

    expect(diagram).toContain("terminal workflow error: dirty target tree");
    expect(diagram).toContain("retry structure analysis in fresh context");
    expect(diagram).toContain("same coder repairs protected-path violation");
    expect(diagram).toContain("same coder repairs gate failure");
    expect(diagram).toContain("retry failed reviewer independently in fresh context");
    expect(diagram).toContain("per-finding repair attempts remain");
  });
});
