import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";

import { BACKLOG_CONTRACT_VERSION } from "../src/contracts/backlog.js";
import { CONTRACT_VERSION } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import { dispatchWithOptions } from "../src/workflows/dispatch/index.js";

test("delivery stages retain evidence and final effects resume independently", async () => {
  const repo = mkdtempSync(join(tmpdir(), "sigil-delivery-resume-"));
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "gpt-5.5" } }, evals: { production: "true" },
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  }));
  const backlogFile = join(repo, "backlog.json");
  writeFileSync(backlogFile, JSON.stringify({ contractVersion: BACKLOG_CONTRACT_VERSION, mission: "delivery",
    items: [{ id: "one", goal: "one", brief: "one", dependsOn: [] }] }));
  const context = createContext(repo, { artifactRoot: join(repo, ".sigil", "runs", "delivery") });
  let finalPrCalls = 0;
  let finalMergeCalls = 0;
  const options = {
    prepareIntegrationBranch: async () => {}, wait: async () => {},
    softwareChange: async (input: { outFile?: string; branch?: string }) => {
      const taskFile = input.outFile!;
      mkdirSync(dirname(taskFile), { recursive: true });
      writeFileSync(taskFile, JSON.stringify({ contractVersion: CONTRACT_VERSION, project: "delivery", goal: "one",
        tasks: [{ id: "one", title: "one", summary: "one", dependencies: [], acceptanceCriteria: ["done"], diagrams: [], files: [] }] }));
      return { stage: "implementation" as const, taskFile, taskCount: 1, valid: true,
        plan: { taskFile, taskCount: 1, valid: true, issues: [], failures: [] }, branch: input.branch,
        prBody: "body", reviewBlocking: false, issues: [], failedTasks: [], noopTasks: [] };
    },
    publish: async (_repo: string, input: { branch: string; base: string }) => ({ push: { ok: true, log: "pushed" },
      pr: { ok: true, log: "pr", evidence: { number: 1, head: input.branch, base: input.base, state: "OPEN" as const } } }),
    merge: async (_repo: string, input: { branch: string; base: string }) => {
      if (input.branch === "integration") finalMergeCalls++;
      return { ok: true, log: "merged", evidence: { number: 1, head: input.branch, base: input.base,
        state: "MERGED" as const, mergedCommit: `${input.branch}-merge` } };
    },
    verifyBase: async () => ({ ok: true, log: "verified" }),
    createPullRequest: async (_repo: string, input: { head: string; base: string }) => {
      finalPrCalls++;
      return { ok: true, log: "created", evidence: { number: 2, head: input.head, base: input.base, state: "OPEN" as const } };
    },
  };
  const input = { repo, backlogFile, deliveryPolicy: "integrationBranch" as const, integrationBranch: "integration",
    finalAction: "mergeWhenGreen" as const, productionGate: "production" };

  await dispatchWithOptions(input, options, context);
  await dispatchWithOptions(input, options, context);

  expect(finalPrCalls).toBe(1);
  expect(finalMergeCalls).toBe(1);
  const state = JSON.parse(readFileSync(context.artifacts.path("dispatch-state.json"), "utf8")) as {
    operations: Array<{ type: string; evidence?: { kind: string } }>;
    operation?: { type: string; evidence?: { kind: string } };
  };
  const operations = [...state.operations, ...(state.operation ? [state.operation] : [])];
  expect(operations.some((operation) => operation.type === "final-pull-request" && operation.evidence?.kind === "remote-pr")).toBe(true);
  expect(operations.some((operation) => operation.type === "final-merge" && operation.evidence?.kind === "merge")).toBe(true);
  expect(operations.some((operation) => operation.type === "production-verification" && operation.evidence?.kind === "verification")).toBe(true);
  const events = readFileSync(context.artifacts.path("events.jsonl"), "utf8");
  expect(events.split("\n").filter((line) => line.includes('"stage":"gate-started"') && line.includes('"gate":"production"'))).toHaveLength(1);
});
