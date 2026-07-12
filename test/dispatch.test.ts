import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { BACKLOG_CONTRACT_VERSION, type Backlog } from "../src/contracts/backlog.js";
import { CONTRACT_VERSION, type TaskGraph } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import {
  createDispatch,
  dispatchWithOptions,
  verifyBase,
  type DispatchInput,
  type DispatchOptions,
} from "../src/workflows/dispatch/index.js";
import type { AttemptResult, PublishResult } from "../src/git.js";
import type { SoftwareChangeInput, SoftwareChangeResult } from "../src/workflows/software-change/workflow.js";

function dispatch(input: DispatchInput, options: DispatchOptions) {
  return dispatchWithOptions(input, { wait: async () => {}, ...options });
}

function tempRepo(evals: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-dispatch-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: {
      planner: { provider: "codex", model: "gpt-5.5" },
      coder: { provider: "codex", model: "gpt-5.5" },
      reviewer: { provider: "codex", model: "gpt-5.5" },
    },
    evals,
    plan: { planners: ["planner"], synthesizer: "planner" },
    implement: { coder: "coder", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
  }, null, 2));
  return dir;
}

function backlogFile(repo: string, backlog: Backlog): string {
  const file = join(repo, "backlog.json");
  writeFileSync(file, JSON.stringify(backlog, null, 2));
  return file;
}

function backlog(): Backlog {
  return {
    contractVersion: BACKLOG_CONTRACT_VERSION,
    mission: "dispatch fixture",
    items: [
      { id: "base", goal: "Build base.", dependsOn: [], brief: "Plan base item." },
      { id: "feature", goal: "Build feature.", dependsOn: ["base"], brief: "Plan feature item." },
      { id: "polish", goal: "Polish feature.", dependsOn: ["feature"], brief: "Plan polish item." },
    ],
  };
}

function taskGraph(repo: string, id: string): TaskGraph {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "fixture",
    goal: id,
    tasks: [{
      id: `${id}-task`,
      title: `Task ${id}`,
      summary: `Do ${id}`,
      dependencies: [],
      acceptanceCriteria: ["works"],
      diagrams: [],
      files: [{ path: join(repo, `${id}.txt`), action: "modify", details: ["update fixture"] }],
    }],
  };
}

function changeResult(input: SoftwareChangeInput, override: Partial<SoftwareChangeResult> = {}): SoftwareChangeResult {
  const id = input.intent.replace(/^Plan | item\.$/g, "").replace(/\s+/g, "-").toLowerCase();
  if (input.outFile) {
    mkdirSync(dirname(input.outFile), { recursive: true });
    writeFileSync(input.outFile, JSON.stringify(taskGraph(input.repo, id), null, 2));
  }
  const issues = override.issues ?? [];
  const failedTasks = override.failedTasks ?? [];
  const reviewBlocking = override.reviewBlocking ?? false;
  return {
    stage: "implementation",
    taskFile: input.taskFile ?? input.outFile ?? join(input.repo, ".sigil", "runs", "task-graph.json"),
    taskCount: 1,
    valid: override.valid ?? (issues.length === 0 && failedTasks.length === 0 && !reviewBlocking),
    plan: { taskFile: input.taskFile ?? input.outFile ?? join(input.repo, ".sigil", "runs", "task-graph.json"), taskCount: 1, valid: true, issues: [], failures: [] },
    implementation: {
      branch: input.branch ?? "missing-branch",
      prBody: "## Issues\n- none\n",
      reviewBlocking: false,
      issues: [],
      failedTasks: [],
      noopTasks: [],
    },
    branch: input.branch ?? "missing-branch",
    prBody: "## Issues\n- none\n",
    reviewBlocking,
    issues,
    failedTasks,
    noopTasks: [],
    ...override,
  };
}

type ChangeCall = {
  intent: string;
  outFile?: string;
  taskFile?: string;
  branch?: string;
  baseBranch?: string;
};

function makeSoftwareChangeStub(
  calls: ChangeCall[] = [],
  byBranch: Record<string, Partial<SoftwareChangeResult>> = {},
  events: string[] = [],
) {
  return async (input: SoftwareChangeInput): Promise<SoftwareChangeResult> => {
    calls.push({
      intent: input.intent,
      outFile: input.outFile,
      taskFile: input.taskFile,
      branch: input.branch,
      baseBranch: input.baseBranch,
    });
    if (input.branch) events.push(`software-change:${input.branch}`);
    return changeResult(input, input.branch ? byBranch[input.branch] : undefined);
  };
}

function makePublishStub(
  calls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [],
  byBranch: Record<string, Partial<PublishResult>> = {},
  events: string[] = [],
) {
  return async (_repo: string, input: { branch: string; title: string; body: string; base: string }): Promise<PublishResult> => {
    calls.push({ repo: _repo, ...input });
    events.push(`publish:${input.branch}`);
    const override = byBranch[input.branch];
    return {
      push: { ok: true, log: "" },
      pr: { ok: true, log: "" },
      ...override,
    };
  };
}

function makeMergeStub(calls: Array<{ repo: string; branch: string; base: string }> = [], byBranch: Record<string, AttemptResult> = {}, events: string[] = []) {
  return async (_repo: string, input: { branch: string; base: string }): Promise<AttemptResult> => {
    calls.push({ repo: _repo, ...input });
    events.push(`merge:${input.branch}`);
    return byBranch[input.branch] ?? { ok: true, log: `merged ${input.branch}` };
  };
}

function makeVerifyBaseStub(calls: Array<{ repo: string }> = [], results: AttemptResult[] = [], events: string[] = []) {
  return async (repo: string): Promise<AttemptResult> => {
    calls.push({ repo });
    events.push("verifyBase");
    return results.shift() ?? { ok: true, log: "verified" };
  };
}

function makeCreatePrStub(
  calls: Array<{ repo: string; title: string; body: string; base: string; head: string }> = [],
  byHead: Record<string, AttemptResult> = {},
) {
  return async (_repo: string, input: { title: string; body: string; base: string; head: string }): Promise<AttemptResult> => {
    calls.push({ repo: _repo, ...input });
    return byHead[input.head] ?? { ok: true, log: "created" };
  };
}

describe("dispatch", () => {
  test("persists capacity waiting without entering deterministic repair", async () => {
    const repo = tempRepo();
    const context = createContext(repo, { artifactRoot: join(repo, ".sigil", "runs", "capacity-wait") });
    let repairs = 0;
    const result = await dispatchWithOptions({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: async (input) => changeResult(input, {
        valid: false,
        reviewBlocking: true,
        issues: ["Codex capacity blocked: no eligible profile"],
      }),
      repairChange: async () => { repairs++; throw new Error("capacity must not enter repair"); },
      wait: async () => {},
    }, context);

    const state = JSON.parse(readFileSync(context.artifacts.path("dispatch-state.json"), "utf8"));
    expect(result).toMatchObject({ status: "waiting", retryable: true, stoppedAt: "base" });
    expect(state.active.id).toBe("base");
    expect(state.operation).toMatchObject({ status: "capacity-blocked", failure: { kind: "capacity" } });
    expect(repairs).toBe(0);
  });

  test("delivers items in dependency order through software-change and per-item branches", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(result.stoppedAt).toBeUndefined();
    expect(changeCalls.map((call) => call.intent)).toEqual(["Plan base item.", "Plan feature item.", "Plan polish item."]);
    expect(changeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
    expect(changeCalls.map((call) => call.baseBranch)).toEqual(["origin/main", "origin/main", "origin/main"]);
    expect(publishCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
    expect(publishCalls.map((call) => call.title)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
    expect(publishCalls.every((call) => call.repo === repo)).toBe(true);
    expect(publishCalls.every((call) => call.body === "## Issues\n- none\n")).toBe(true);
    expect(publishCalls.every((call) => call.base === "main")).toBe(true);
    expect(changeCalls.every((call) => call.outFile?.includes("/dispatch/"))).toBe(true);
  });

  test("resumes interrupted implementation through recovery without software-change reset", async () => {
    const repo = tempRepo();
    const input = { repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" as const };
    const context = createContext(repo, { artifactRoot: join(repo, ".sigil", "runs", "implementation-resume") });
    let initializationCalls = 0;
    let softwareCalls = 0;
    let recoveryCalls = 0;

    await expect(dispatchWithOptions(input, {
      initialize: async () => { initializationCalls++; },
      softwareChange: async () => { softwareCalls++; throw new Error("interrupted implementation"); },
      wait: async () => {},
    }, context)).rejects.toThrow("interrupted implementation");

    const result = await dispatchWithOptions(input, {
      initialize: async () => { initializationCalls++; },
      softwareChange: async (changeInput) => {
        softwareCalls++;
        if (changeInput.branch === "sigil/base") throw new Error("software-change must not restart");
        return changeResult(changeInput);
      },
      recoverChange: async (_ctx, recoveryInput) => {
        recoveryCalls++;
        return changeResult({
          repo,
          intent: recoveryInput.item.brief,
          branch: recoveryInput.branch,
          baseBranch: recoveryInput.baseBranch,
          taskFile: recoveryInput.taskFile,
        });
      },
      publish: makePublishStub(),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
      wait: async () => {},
    }, context);

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(initializationCalls).toBe(1);
    expect(softwareCalls).toBe(3);
    expect(recoveryCalls).toBe(1);
  });

  test("resumes interruption at repair, publish, merge, and verify boundaries", async () => {
    for (const interrupted of ["repair", "publish", "merge", "verify"] as const) {
      const repo = tempRepo();
      const input = { repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" as const };
      const context = createContext(repo, {
        artifactRoot: join(repo, ".sigil", "runs", `${interrupted}-resume`),
      });
      let interruptedOnce = false;
      const interrupt = async <T>(stage: typeof interrupted, value: T): Promise<T> => {
        if (interrupted === stage && !interruptedOnce) {
          interruptedOnce = true;
          throw new Error(`interrupted ${stage}`);
        }
        return value;
      };
      const undeliverable: Record<string, Partial<SoftwareChangeResult>> = interrupted === "repair"
        ? { "sigil/base": { valid: false, reviewBlocking: true, issues: ["repair me"] } }
        : {};
      const options: DispatchOptions = {
        softwareChange: makeSoftwareChangeStub([], undeliverable),
        repairChange: async (_ctx, recoveryInput) => interrupt("repair", changeResult({
          repo,
          intent: recoveryInput.item.brief,
          branch: recoveryInput.branch,
          baseBranch: recoveryInput.baseBranch,
          taskFile: recoveryInput.taskFile,
        })),
        publish: async (targetRepo, publishInput) => interrupt("publish", await makePublishStub()(targetRepo, publishInput)),
        merge: async (targetRepo, mergeInput) => interrupt("merge", await makeMergeStub()(targetRepo, mergeInput)),
        verifyBase: async (targetRepo) => interrupt("verify", await makeVerifyBaseStub()(targetRepo)),
        wait: async () => {},
      };

      await expect(dispatchWithOptions(input, options, context)).rejects.toThrow(`interrupted ${interrupted}`);
      const interruptedState = JSON.parse(readFileSync(context.artifacts.path("dispatch-state.json"), "utf8")) as {
        operation?: { status: string; inputArtifact: string };
      };
      expect(interruptedState.operation?.status).toBe("running");
      expect(existsSync(interruptedState.operation!.inputArtifact)).toBe(true);
      const resumed = await dispatchWithOptions(input, options, context);

      expect(resumed.delivered).toEqual(["base", "feature", "polish"]);
    }
  });


  test("planning failure keeps the dispatch-facing plan failure result", async () => {
    const repo = tempRepo();
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub([], {
        "sigil/base": {
          stage: "planning",
          valid: false,
          branch: undefined,
          prBody: undefined,
          reviewBlocking: true,
          issues: ["invalid graph"],
          implementation: undefined,
        },
      }),
      publish: makePublishStub(publishCalls),
    });

    expect(result.delivered).toEqual([]);
    expect(result.stoppedAt).toBe("base");
    expect(result.results).toEqual([{
      item: "base",
      branch: undefined,
      prCreated: false,
      reviewBlocking: false,
      issues: ["plan failed for base", "invalid graph"],
    }]);
    expect(publishCalls).toEqual([]);
  });

  test("passes dispatch task graph artifact paths to software-change", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(changeCalls.map((call) => call.outFile?.split("/dispatch/").at(-1))).toEqual([
      "base/task-graph.json",
      "feature/task-graph.json",
      "polish/task-graph.json",
    ]);
    expect(changeCalls[0]?.outFile?.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
    expect(existsSync(changeCalls[0]?.outFile ?? "")).toBe(true);
  });

  test("keeps nested software-change artifacts under the active run context", async () => {
    const repo = tempRepo();
    const artifactRoot = join(repo, ".sigil", "runs", "active", "artifacts");
    const ctx = createContext(repo, { artifactRoot });
    const changeCalls: ChangeCall[] = [];
    const workflow = createDispatch({
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    await workflow(
      {
        repo,
        backlogFile: backlogFile(repo, backlog()),
        deliveryPolicy: "mergeWhenGreen",
      },
      ctx,
    );

    expect(changeCalls.map((call) => call.outFile)).toEqual([
      join(artifactRoot, "dispatch", "base", "task-graph.json"),
      join(artifactRoot, "dispatch", "feature", "task-graph.json"),
      join(artifactRoot, "dispatch", "polish", "task-graph.json"),
    ]);
  });

  test("uses ready task files without planning and still publishes through delivery policy", async () => {
    const repo = tempRepo();
    const readyTaskFile = join(repo, "ready-task-graph.json");
    const inputBacklog = {
      contractVersion: BACKLOG_CONTRACT_VERSION,
      mission: "dispatch fixture",
      items: [
        { id: "ready", goal: "Build ready.", dependsOn: [], brief: "Should not plan.", taskFile: readyTaskFile },
        { id: "ordinary", goal: "Build ordinary.", dependsOn: ["ready"], brief: "Plan ordinary item." },
      ],
    } as Backlog;
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, inputBacklog), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["ready", "ordinary"]);
    expect(changeCalls.map((call) => call.intent)).toEqual(["Should not plan.", "Plan ordinary item."]);
    expect(changeCalls.map((call) => call.taskFile)).toEqual([readyTaskFile, undefined]);
    expect(changeCalls[0]?.outFile).toBeUndefined();
    expect(changeCalls[1]?.outFile?.split("/dispatch/").at(-1)).toBe("ordinary/task-graph.json");
    expect(publishCalls.map((call) => call.branch)).toEqual(["sigil/ready", "sigil/ordinary"]);
  });

  test("mergeWhenGreen merges and verifies each item before implementing dependents", async () => {
    const repo = tempRepo();
    const events: string[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const verifyCalls: Array<{ repo: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub([], {}, events),
      publish: makePublishStub(publishCalls, {}, events),
      merge: makeMergeStub(mergeCalls, {}, events),
      verifyBase: makeVerifyBaseStub(verifyCalls, [], events),
    });

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(result.stoppedAt).toBeUndefined();
    expect(events.indexOf("publish:sigil/base")).toBeLessThan(events.indexOf("merge:sigil/base"));
    expect(events.indexOf("merge:sigil/base")).toBeLessThan(events.indexOf("verifyBase"));
    expect(events.indexOf("verifyBase")).toBeLessThan(events.indexOf("software-change:sigil/feature"));
    expect(mergeCalls.map((call) => ({ branch: call.branch, base: call.base }))).toEqual([
      { branch: "sigil/base", base: "main" },
      { branch: "sigil/feature", base: "main" },
      { branch: "sigil/polish", base: "main" },
    ]);
    const byItem = Object.fromEntries(result.results.map((r) => [r.item, r]));
    expect(byItem.feature.issues.join("\n")).not.toContain("without unmerged changes from dependencies");
    expect(byItem.polish.issues.join("\n")).not.toContain("without unmerged changes from dependencies");
  });

  test("integration branch accumulates item changes and opens one final PR to main", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const prepareCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const finalPrCalls: Array<{ repo: string; title: string; body: string; base: string; head: string }> = [];
    const integrationBranch = "feature/site-studio";

    const result = await dispatch({
      repo,
      backlogFile: backlogFile(repo, backlog()),
      deliveryPolicy: "integrationBranch",
      integrationBranch,
    }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(mergeCalls),
      createPullRequest: makeCreatePrStub(finalPrCalls),
      verifyBase: makeVerifyBaseStub(),
      prepareIntegrationBranch: async (targetRepo, branch, base) => {
        prepareCalls.push({ repo: targetRepo, branch, base });
      },
    });

    expect(prepareCalls).toEqual([{ repo, branch: integrationBranch, base: "main" }]);
    expect(changeCalls.every((call) => call.baseBranch === `origin/${integrationBranch}`)).toBe(true);
    expect(publishCalls.every((call) => call.base === integrationBranch)).toBe(true);
    expect(mergeCalls.every((call) => call.base === integrationBranch)).toBe(true);
    expect(finalPrCalls).toEqual([{ repo, title: "dispatch fixture", body: "## Dispatch issues\n- none\n", base: "main", head: integrationBranch }]);
    expect(mergeCalls.map((call) => call.branch)).not.toContain(integrationBranch);
    expect(result.finalPullRequest).toEqual({
      branch: integrationBranch,
      base: "main",
      created: true,
      issues: [],
    });
  });

  test("integration branch reports a failed final PR without merging it", async () => {
    const repo = tempRepo();
    const integrationBranch = "feature/site-studio";

    const result = await dispatch({
      repo,
      backlogFile: backlogFile(repo, backlog()),
      deliveryPolicy: "integrationBranch",
      integrationBranch,
    }, {
      softwareChange: makeSoftwareChangeStub(),
      publish: makePublishStub(),
      merge: makeMergeStub(),
      createPullRequest: makeCreatePrStub([], {
        [integrationBranch]: { ok: false, log: "final PR failed" },
      }),
      verifyBase: makeVerifyBaseStub(),
      prepareIntegrationBranch: async () => {},
    });

    expect(result.stoppedAt).toBe("final-pull-request");
    expect(result.finalPullRequest).toEqual({
      branch: integrationBranch,
      base: "main",
      created: false,
      issues: ["pull request creation failed: final PR failed"],
    });
  });

  test("mergeWhenGreen stops on merge failure without attempting later items", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const verifyCalls: Array<{ repo: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(),
      merge: makeMergeStub(mergeCalls, { "sigil/feature": { ok: false, log: "merge red" } }),
      verifyBase: makeVerifyBaseStub(verifyCalls),
    });

    expect(result.delivered).toEqual(["base"]);
    expect(result.stoppedAt).toBe("feature");
    expect(result.results.map((item) => item.item)).toEqual(["base", "feature"]);
    expect(changeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature"]);
    expect(mergeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/feature", "sigil/feature", "sigil/feature"]);
    expect(verifyCalls).toHaveLength(1);
    expect(result.results[1].issues).toContain("merge failed: merge red");
  });

  test("mergeWhenGreen retries base verification and continues", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const verifyCalls: Array<{ repo: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(),
      merge: makeMergeStub(mergeCalls),
      verifyBase: makeVerifyBaseStub(verifyCalls, [{ ok: true, log: "base ok" }, { ok: false, log: "verify red" }]),
    });

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(result.stoppedAt).toBeUndefined();
    expect(result.results.map((item) => item.item)).toEqual(["base", "feature", "polish"]);
    expect(changeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
    expect(mergeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
    expect(verifyCalls).toHaveLength(4);
  });

  test("mergeWhenGreen stops failed tasks before publishing, merging, or verification", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];
    const verifyCalls: Array<{ repo: string }> = [];
    const inputBacklog: Backlog = {
      contractVersion: BACKLOG_CONTRACT_VERSION,
      mission: "dispatch fixture",
      items: [
        { id: "base", goal: "Build base.", dependsOn: [], brief: "Plan base item." },
        { id: "feature", goal: "Build feature.", dependsOn: ["base"], brief: "Plan feature item." },
        { id: "independent", goal: "Build independent.", dependsOn: [], brief: "Plan independent item." },
      ],
    };

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, inputBacklog), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls, { "sigil/base": { failedTasks: ["base-task"], issues: ["task failed"] } }),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(mergeCalls),
      verifyBase: makeVerifyBaseStub(verifyCalls),
    });

    expect(result.delivered).toEqual([]);
    expect(result.stoppedAt).toBe("base");
    expect(result.results.map((item) => item.item)).toEqual(["base"]);
    expect(result.results[0].issues).toContain("implement reported failed tasks: base-task");
    expect(changeCalls.map((call) => call.intent)).toEqual(["Plan base item."]);
    expect(changeCalls.map((call) => call.branch)).toEqual(["sigil/base"]);
    expect(publishCalls).toEqual([]);
    expect(mergeCalls).toEqual([]);
    expect(verifyCalls).toEqual([]);
  });

  test("mergeWhenGreen stops an invalid change before publishing or merging it", async () => {
    const repo = tempRepo();
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];

    const result = await dispatch({
      repo,
      backlogFile: backlogFile(repo, backlog()),
      deliveryPolicy: "mergeWhenGreen",
    }, {
      softwareChange: makeSoftwareChangeStub([], {
        "sigil/base": { valid: false, issues: ["unresolved issue"] },
      }),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(mergeCalls),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual([]);
    expect(result.stoppedAt).toBe("base");
    expect(result.results[0].issues).toContain("unresolved issue");
    expect(publishCalls).toEqual([]);
    expect(mergeCalls).toEqual([]);
  });

  test("integrationBranch stops an invalid change before publishing or merging into the integration branch", async () => {
    const repo = tempRepo();
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];
    const mergeCalls: Array<{ repo: string; branch: string; base: string }> = [];

    const result = await dispatch({
      repo,
      backlogFile: backlogFile(repo, backlog()),
      deliveryPolicy: "integrationBranch",
      integrationBranch: "feature/mission",
    }, {
      softwareChange: makeSoftwareChangeStub([], {
        "sigil/base": { valid: false, issues: ["unresolved issue"] },
      }),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(mergeCalls),
      verifyBase: makeVerifyBaseStub(),
      prepareIntegrationBranch: async () => {},
    });

    expect(result.delivered).toEqual([]);
    expect(result.stoppedAt).toBe("base");
    expect(result.finalPullRequest).toBeUndefined();
    expect(publishCalls).toEqual([]);
    expect(mergeCalls).toEqual([]);
  });

  test("verifyBase treats absent build and test evals as green", async () => {
    const result = await verifyBase(tempRepo());

    expect(result).toEqual({ ok: true, log: "" });
  });

  test("verifyBase fails on the first configured red build or test eval", async () => {
    const buildRepo = tempRepo({ build: "echo build failed; exit 1", test: "touch should-not-run" });
    const buildResult = await verifyBase(buildRepo);
    expect(buildResult.ok).toBe(false);
    expect(buildResult.log).toContain("build failed");
    expect(existsSync(join(buildRepo, "should-not-run"))).toBe(false);

    const testRepo = tempRepo({ build: "echo build ok", test: "echo test failed; exit 1" });
    const testResult = await verifyBase(testRepo);
    expect(testResult.ok).toBe(false);
    expect(testResult.log).toContain("test failed");
  });

  test("reviewBlocking workflow result stops the loop and leaves later items unattempted", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls, { "sigil/feature": { reviewBlocking: true, issues: ["blocking review"] } }),
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["base"]);
    expect(result.stoppedAt).toBe("feature");
    expect(result.results.map((item) => item.item)).toEqual(["base", "feature"]);
    expect(changeCalls.map((call) => call.intent)).toEqual(["Plan base item.", "Plan feature item."]);
    expect(changeCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature"]);
    expect(publishCalls.map((call) => call.branch)).toEqual(["sigil/base"]);
  });

  test("repairs an undeliverable result on its existing branch and continues delivery", async () => {
    const repo = tempRepo();
    const repairCalls: string[][] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub([], {
        "sigil/base": { valid: false, reviewBlocking: true, issues: ["weakened tests"] },
      }),
      repairChange: async (_ctx, input) => {
        repairCalls.push([input.branch, ...input.issues]);
        return changeResult({ repo, intent: input.item.brief, branch: input.branch, taskFile: input.taskFile });
      },
      publish: makePublishStub(publishCalls),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["base", "feature", "polish"]);
    expect(repairCalls).toEqual([["sigil/base", "weakened tests", "review blocked delivery for base"]]);
    expect(publishCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/polish"]);
  });

  test("publish PR failure stops at the failed item", async () => {
    const repo = tempRepo();
    const changeCalls: ChangeCall[] = [];
    const publishCalls: Array<{ repo: string; branch: string; title: string; body: string; base: string }> = [];

    const result = await dispatch({ repo, backlogFile: backlogFile(repo, backlog()), deliveryPolicy: "mergeWhenGreen" }, {
      softwareChange: makeSoftwareChangeStub(changeCalls),
      publish: makePublishStub(publishCalls, { "sigil/feature": { pr: { ok: false, log: "no pr" } } }),
      merge: makeMergeStub(),
      verifyBase: makeVerifyBaseStub(),
    });

    expect(result.delivered).toEqual(["base"]);
    expect(result.stoppedAt).toBe("feature");
    expect(result.results.map((item) => item.item)).toEqual(["base", "feature"]);
    expect(result.results[1].prCreated).toBe(false);
    expect(result.results[1].issues).toContain("pr create failed: no pr");
    expect(publishCalls.map((call) => call.branch)).toEqual(["sigil/base", "sigil/feature", "sigil/feature", "sigil/feature", "sigil/feature"]);
  });

  test("diagram documents dispatch-owned delivery and software-change dependency direction", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/dispatch/workflow.mermaid"), "utf8");

    expect(diagram).toContain("read and validate backlog");
    expect(diagram).toContain("serial dependency-ordered item loop");
    expect(diagram).toContain("fork dispatch item artifact context");
    expect(diagram).toContain("call softwareChange in item context on item branch from refreshed delivery base");
    expect(diagram).toContain("create or resume integration branch");
    expect(diagram).toContain("journal and reconcile evidence");
    expect(diagram).toContain("journal exact commit and configured production gate");
    expect(diagram).toContain("fetch origin delivery base and detach worktree there");
    expect(diagram).toContain("run build and test on updated delivery base after synced checkout");
    expect(diagram).toContain("change valid and issue-free");
  });
});
