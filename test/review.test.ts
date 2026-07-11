import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "sigil-review-test-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: {
      coder: { provider: "codex", model: "gpt-5.5" },
      reviewer: { provider: "codex", model: "gpt-5.5" },
    },
    evals: {},
    workspace: {},
    context: [],
    plan: { planners: ["reviewer"], synthesizer: "reviewer" },
    implement: { coder: "coder", batchSize: 5, repairLimit, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewer: "reviewer", followUpReviews },
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

    const result = await review({ repo, base, autofix: true }, context(repo, actions));

    expect(result.valid).toBe(true);
    expect(result.fixRan).toBe(true);
    expect(result.structuredFindings).toEqual([]);
    expect(actions).toHaveLength(0);
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
