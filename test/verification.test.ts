import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createContext } from "../src/context.js";
import { establishBaseline, runBuildAndTest, runGateSet, verificationMatchesCurrentState, verifyWithRepair } from "../src/verification.js";
import { loadConfig } from "../src/config.js";

function fixture(build = "true", testCommand = "true") {
  const repo = mkdtempSync(join(tmpdir(), "sigil-verification-"));
  const artifacts = mkdtempSync(join(tmpdir(), "sigil-verification-artifacts-"));
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: { worker: { provider: "codex", model: "gpt-5.5", effort: "medium" } },
    evals: { build, test: testCommand },
    context: [],
    plan: { planners: ["worker"], synthesizer: "worker", reviewer: "worker", semanticReviewLimit: 2 },
    implement: {
      coder: "worker",
      sessionTaskLimit: 1,
      repairLimit: 2,
      branchPrefix: "test/",
      baseBranch: "main",
    },
    review: { reviewers: ["worker"], synthesizer: "worker" },
  }));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
  return { repo, artifacts, ctx: createContext(repo, { artifactRoot: artifacts }) };
}

describe("shared verification", () => {
  test("runs build and test and records observable state", async () => {
    const { ctx, artifacts } = fixture();

    const result = await runBuildAndTest(ctx);

    expect(result.ok).toBe(true);
    expect(result.gates.map((gate) => gate.name)).toEqual(["build", "test"]);
    expect(readFileSync(join(artifacts, "events.jsonl"), "utf8")).toContain("gate-completed");
    expect(JSON.parse(readFileSync(join(artifacts, "status.json"), "utf8")).stage).toBe("verification-completed");
  });

  test("rejects a red baseline without structured comparison", async () => {
    const { repo, ctx } = fixture("false");

    const result = await establishBaseline(ctx, repo, loadConfig(repo));

    expect("kind" in result).toBe(true);
  });

  test("skips gates covered by a stronger requested gate", async () => {
    const { repo, ctx } = fixture();
    const config = JSON.parse(readFileSync(join(repo, "sigil.config.json"), "utf8"));
    config.evals.verify = { command: "true", covers: ["test"] };
    writeFileSync(join(repo, "sigil.config.json"), JSON.stringify(config));
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "configure verify"], { cwd: repo });

    const result = await runGateSet(ctx, ["build", "test", "verify"]);

    expect(result.gates.map((gate) => gate.name)).toEqual(["build", "verify"]);
  });

  test("reuses verification only for the same repository state and gate plan", async () => {
    const { repo, ctx } = fixture();
    const result = await runBuildAndTest(ctx);

    expect(await verificationMatchesCurrentState(ctx, result, ["build", "test"]))
      .toBe(true);

    writeFileSync(join(repo, "changed.txt"), "changed\n");

    expect(await verificationMatchesCurrentState(ctx, result, ["build", "test"]))
      .toBe(false);
  });

  test("keeps recovered failures in attempt history", async () => {
    const { ctx } = fixture();
    let attempts = 0;

    const result = await verifyWithRepair({
      ctx,
      stage: "slice:test",
      limit: 2,
      verify: async () => ({
        ok: ++attempts > 1,
        gates: [],
        evidence: "first attempt failed",
      }),
      repair: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(ctx.issues).toEqual([]);
  });
});
