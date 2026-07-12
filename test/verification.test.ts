import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createContext } from "../src/context.js";
import { establishBaseline, runBuildAndTest, verifyWithRepair } from "../src/verification.js";
import { loadConfig } from "../src/config.js";

function fixture(build = "true", testCommand = "true") {
  const repo = mkdtempSync(join(tmpdir(), "sigil-verification-"));
  const artifacts = mkdtempSync(join(tmpdir(), "sigil-verification-artifacts-"));
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: { worker: { provider: "codex", model: "gpt-5.5", effort: "medium" } },
    evals: { build, test: testCommand },
    context: [],
    plan: { planners: ["worker"], synthesizer: "worker" },
    implement: {
      coder: "worker",
      batchSize: 1,
      repairLimit: 2,
      branchPrefix: "test/",
      baseBranch: "main",
    },
    review: { reviewers: ["worker"], synthesizer: "worker" },
  }));
  return { repo, artifacts, ctx: createContext(repo, { artifactRoot: artifacts }) };
}

describe("shared verification", () => {
  test("runs build and test and records observable state", async () => {
    const { ctx, artifacts } = fixture();

    const result = await runBuildAndTest(ctx);

    expect(result.ok).toBe(true);
    expect(result.gates.map((gate) => gate.name)).toEqual(["build", "test"]);
    expect(readFileSync(join(artifacts, "events.jsonl"), "utf8")).toContain("gate-completed");
    expect(JSON.parse(readFileSync(join(artifacts, "status.json"), "utf8")).stage).toBe("gate-completed");
  });

  test("rejects a red baseline without structured comparison", async () => {
    const { repo, ctx } = fixture("false");

    const result = await establishBaseline(ctx, repo, loadConfig(repo));

    expect("kind" in result).toBe(true);
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
