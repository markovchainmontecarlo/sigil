import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import type { SigilAgent } from "../src/agents.js";
import { createContext } from "../src/context.js";
import { review, type ReviewFinding } from "../src/workflows/software-change/review/index.js";

type AgentAction = (prompt: string) => unknown;

class StubAgent implements SigilAgent {
  calls: string[] = [];

  constructor(private readonly action: AgentAction) {}

  async prompt<T>(prompt: string, schema?: z.ZodType<T>): Promise<string | T> {
    this.calls.push(prompt);
    const value = this.action(prompt);
    if (schema) return schema.parse(value);
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function fixture(
  repairLimit = 2,
  followUpReviews = 0,
  reviewers = ["reviewer"],
): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "sigil-review-test-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: Object.fromEntries([
      ["coder", { provider: "codex", model: "gpt-5.5" }],
      ...reviewers.map((reviewer) => [reviewer, { provider: "codex", model: "gpt-5.5" }]),
      ["synthesizer", { provider: "codex", model: "gpt-5.5" }],
    ]),
    evals: {},
    workspace: {},
    context: [],
    plan: { planners: [reviewers[0]], synthesizer: reviewers[0] },
    implement: { coder: "coder", sessionTaskLimit: 5, repairLimit, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers, synthesizer: reviewers.length > 1 ? "synthesizer" : reviewers[0], followUpReviews },
  }, null, 2));
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return { repo, base: git(repo, ["rev-parse", "HEAD"]).trim() };
}

function finding(override: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "concurrent-create",
    severity: "high",
    path: "app.txt",
    line: 1,
    failureScenario: "Two writers race and one fails.",
    defect: "The write is not idempotent.",
    requiredChange: "Make the write atomic.",
    repairRecommended: true,
    source: "correctness",
    ...override,
  };
}

function changeApp(repo: string): void {
  writeFileSync(join(repo, "app.txt"), "after\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "change"]);
}

function context(repo: string, actions: AgentAction[]) {
  return createContext(repo, {
    createAgent: () => {
      const action = actions.shift();
      if (!action) throw new Error("unexpected agent");
      return new StubAgent(action);
    },
  });
}

describe("structured software-change review", () => {
  test("returns without agents for an empty diff", async () => {
    const { repo } = fixture();
    const result = await review({ repo, base: "HEAD", autofix: true }, context(repo, []));

    expect(result.valid).toBe(true);
    expect(result.structuredFindings).toEqual([]);
    expect(result.fixRan).toBe(false);
  });

  test("fans out independent reviewers and synthesizes distinct findings", async () => {
    const reviewers = ["sol", "terra", "luna"];
    const { repo, base } = fixture(2, 0, reviewers);
    changeApp(repo);
    const stateFinding = finding({ id: "state-loss" });
    const retryFinding = finding({ id: "duplicate-retry", defect: "A retry duplicates the side effect." });
    const actions: AgentAction[] = [
      () => ({ findings: [stateFinding] }),
      () => ({ findings: [retryFinding] }),
      () => ({ findings: [] }),
      () => ({ findings: [stateFinding, retryFinding] }),
    ];

    const ctx = context(repo, actions);
    const result = await review({ repo, base, autofix: false }, ctx);
    const operations = JSON.parse(readFileSync(ctx.artifacts.path("review/operations.json"), "utf8")) as {
      operations: Array<{ type: string; status: string; inputArtifact: string; outputArtifact?: string }>;
    };

    expect(result.structuredFindings?.map((item) => item.id)).toEqual(["state-loss", "duplicate-retry"]);
    expect(operations.operations.filter((operation) => operation.type === "review/panel")).toHaveLength(3);
    expect(new Set(operations.operations.map((operation) => operation.inputArtifact)).size).toBe(4);
    expect(operations.operations.every((operation) => operation.status === "completed")).toBe(true);
    expect(actions).toHaveLength(0);
  });

  test("repairs a high finding without a follow-up review by default", async () => {
    const { repo, base } = fixture();
    changeApp(repo);
    const actions: AgentAction[] = [
      () => ({ findings: [finding()] }),
      () => {
        writeFileSync(join(repo, "app.txt"), "atomic\n");
        return "fixed";
      },
    ];

    const ctx = context(repo, actions);
    const result = await review({ repo, base, autofix: true }, ctx);
    const operations = JSON.parse(readFileSync(ctx.artifacts.path("review/operations.json"), "utf8")) as {
      operations: Array<{ type: string; status: string; inputArtifact: string; outputArtifact?: string }>;
    };

    expect(result.valid).toBe(true);
    expect(result.fixRan).toBe(true);
    expect(result.structuredFindings).toEqual([]);
    expect(actions).toHaveLength(0);
    expect(operations.operations.map((operation) => operation.type)).toEqual([
      "review/panel",
      "review/synthesis",
      "review/repair",
      "post-review-verification",
    ]);
    expect(operations.operations.every((operation) => operation.status === "completed")).toBe(true);
    expect(operations.operations.every((operation) => operation.inputArtifact && operation.outputArtifact)).toBe(true);
    expect(readFileSync(ctx.artifacts.path("review/dispositions.json"), "utf8")).toContain("resolved");
  });

  test("runs the configured number of follow-up reviews", async () => {
    const { repo, base } = fixture(2, 1);
    changeApp(repo);
    const actions: AgentAction[] = [
      () => ({ findings: [finding({ severity: "medium" })] }),
      () => "fixed",
      () => ({ findings: [] }),
    ];

    const result = await review({ repo, base, autofix: true }, context(repo, actions));

    expect(result.valid).toBe(true);
    expect(result.fixRan).toBe(true);
  });

  test("does not repair a medium the reviewer marks as not recommended", async () => {
    const { repo, base } = fixture();
    changeApp(repo);
    const result = await review({ repo, base, autofix: true }, context(repo, [
      () => ({ findings: [finding({ severity: "medium", repairRecommended: false })] }),
    ]));

    expect(result.valid).toBe(true);
    expect(result.fixRan).toBe(false);
    expect(result.structuredFindings).toHaveLength(1);
  });

  test("repairs weakened tests and runs a configured integrity follow-up", async () => {
    const { repo, base } = fixture(2, 1);
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test", "app.test.ts"), "expect(value).toBe(2);\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "change test"]);
    const weakened = finding({
      id: "removed-assertion",
      path: "test/app.test.ts",
      source: "test-integrity",
    });
    const actions: AgentAction[] = [
      () => ({ findings: [] }),
      () => ({ weakened: true, findings: [weakened] }),
      () => {
        writeFileSync(join(repo, "test", "app.test.ts"), "expect(value).toBe(1);\n");
        return "restored";
      },
      () => ({ findings: [] }),
      () => ({ weakened: false, findings: [] }),
    ];

    const result = await review({ repo, base, autofix: true }, context(repo, actions));

    expect(result.valid).toBe(true);
    expect(result.fixRan).toBe(true);
    expect(result.issues).toEqual([]);
    expect(actions).toHaveLength(0);
  });

  test("stops only after one stable finding exhausts its repair budget", async () => {
    const { repo, base } = fixture(1, 1);
    changeApp(repo);
    const actions: AgentAction[] = [
      () => ({ findings: [finding()] }),
      () => "not fixed",
      () => ({ findings: [finding()] }),
    ];

    const result = await review({ repo, base, autofix: true }, context(repo, actions));

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("exhausted repair");
  });
});
