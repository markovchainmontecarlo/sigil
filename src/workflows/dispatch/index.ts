import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadConfig } from "../../config.js";
import { sigil, type SigilContext } from "../../context.js";
import { orderItems, validateBacklog, type WorkItem } from "../../contracts/backlog.js";
import { evalGate } from "../../gate.js";
import {
  checkoutIntegrationBranch,
  createPr,
  git,
  mergePr,
  publish,
  type AttemptResult,
  type PublishResult,
} from "../../git.js";
import {
  softwareChange,
  type SoftwareChangeInput,
  type SoftwareChangeResult,
} from "../software-change/workflow.js";
import { recoverInterruptedSoftwareChange, repairExistingChange, type ExistingBranchRepairInput } from "./recovery.js";
import { readRepositoryState } from "../../recovery/git-snapshot.js";
import {
  dispatchBacklogDigest,
  dispatchValueDigest,
  startDispatchOperation,
  loadDispatchCheckpoint,
  writeDispatchCheckpoint,
  type DispatchCheckpoint,
  type DispatchActiveItem,
  type DispatchOperationType,
  type DispatchOperation,
  readDispatchRuntime,
} from "./state.js";

export type DeliveryPolicy = "mergeWhenGreen" | "integrationBranch";
type DispatchBaseInput = { backlogFile: string; repo: string };
export type DispatchInput = DispatchBaseInput & (
  | { deliveryPolicy: "mergeWhenGreen" }
  | {
      deliveryPolicy: "integrationBranch";
      integrationBranch: string;
      finalAction?: "openPullRequest" | "mergeWhenGreen";
      productionGate?: string;
    }
);
type DispatchWorkItem = WorkItem & { taskFile?: string };
export type DispatchItemResult = {
  item: string;
  branch?: string;
  prCreated: boolean;
  reviewBlocking: boolean;
  issues: string[];
};
export type FinalPullRequestResult = {
  branch: string;
  base: string;
  created: boolean;
  merged?: boolean;
  productionVerified?: boolean;
  issues: string[];
};
export type DispatchResult = {
  delivered: string[];
  stoppedAt?: string;
  results: DispatchItemResult[];
  finalPullRequest?: FinalPullRequestResult;
};
export type VerifyBaseResult = { ok: boolean; log: string };

export type DispatchOptions = {
  softwareChange?: typeof softwareChange;
  publish?: typeof publish;
  merge?: typeof mergePr;
  createPullRequest?: typeof createPr;
  verifyBase?: (repo: string) => Promise<VerifyBaseResult>;
  prepareIntegrationBranch?: typeof checkoutIntegrationBranch;
  repairChange?: (ctx: SigilContext, input: ExistingBranchRepairInput) => Promise<SoftwareChangeResult>;
  recoverChange?: (ctx: SigilContext, input: ExistingBranchRepairInput) => Promise<SoftwareChangeResult>;
  wait?: (milliseconds: number) => Promise<void>;
};

type DispatchChangeResult = Pick<
  SoftwareChangeResult,
  | "stage"
  | "valid"
  | "branch"
  | "prBody"
  | "reviewBlocking"
  | "issues"
  | "failedTasks"
>;

async function beginOperation(
  checkpointFile: string,
  state: DispatchCheckpoint,
  ctx: SigilContext,
  input: {
    type: DispatchOperationType;
    name: string;
    value: unknown;
    repo: string;
    repairBudget: number;
  },
): Promise<void> {
  const inputArtifact = await ctx.artifacts.write(
    `${input.name}-input.json`,
    `${JSON.stringify(input.value, null, 2)}\n`,
  );
  const repository = await repositoryExpectation(input.repo);
  state.operation = startDispatchOperation({
    type: input.type,
    inputArtifact,
    input: input.value,
    repository,
    repairBudget: input.repairBudget,
  });
  await writeDispatchCheckpoint(checkpointFile, state);
}

async function completeOperation(
  checkpointFile: string,
  state: DispatchCheckpoint,
  ctx: SigilContext,
  input: { name: string; value: unknown; repo: string; failed?: boolean },
): Promise<void> {
  if (!state.operation) throw new Error("dispatch operation is missing");
  const outputArtifact = await ctx.artifacts.write(
    `${input.name}-output.json`,
    `${JSON.stringify(input.value, null, 2)}\n`,
  );
  state.operation.outputArtifact = outputArtifact;
  state.operation.repositoryAfter = await repositoryExpectation(input.repo);
  state.operation.gates = {
    ...state.operation.gates,
    ...await collectGateResults(ctx, state.operation.inputDigest),
  };
  const runtime = await readDispatchRuntime(join(dirname(checkpointFile), "dispatch-runtime.json"));
  if (runtime?.providerSessionId) {
    state.operation.agent = {
      binding: runtime.binding ?? "default",
      providerSessionId: runtime.providerSessionId,
    };
  }
  if (runtime?.childProcessId && runtime.childStartIdentity) {
    state.operation.child = {
      pid: runtime.childProcessId,
      startIdentity: runtime.childStartIdentity,
    };
  }
  state.operation.status = input.failed ? "failed" : "completed";
  await writeDispatchCheckpoint(checkpointFile, state);
}

async function collectGateResults(
  ctx: SigilContext,
  inputDigest: string,
): Promise<DispatchOperation["gates"]> {
  let contents: string;
  try {
    contents = await readFile(ctx.artifacts.path("events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const gates: DispatchOperation["gates"] = {};
  for (const line of contents.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as { stage?: string; gate?: string; outcome?: string; command?: string };
    if (event.stage !== "gate-completed" || !event.gate) continue;
    const status = event.outcome === "passed" || event.outcome === "failed" ? event.outcome : "skipped";
    gates[event.gate] = { status, inputDigest, evidence: event.command };
  }
  return gates;
}

async function repositoryExpectation(repo: string) {
  try {
    const observed = await readRepositoryState(repo);
    return {
      branch: observed.branch,
      expectedHead: observed.head,
      tree: observed.dirty ? "dirty" as const : "clean" as const,
      diffDigest: observed.diffDigest,
    };
  } catch {
    return { branch: "unknown", tree: "clean" as const };
  }
}

function itemBranch(repo: string, item: WorkItem): string {
  return `${loadConfig(repo).implement.branchPrefix}${item.id}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryResult<T>(
  run: () => Promise<T>,
  successful: (value: T) => boolean,
  limit: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let value = await run();
  for (let attempt = 1; !successful(value) && attempt <= limit; attempt++) {
    await wait(5_000);
    value = await run();
  }
  return value;
}

async function currentCommit(repo: string, ref: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", ref]);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function changeIssues(item: WorkItem, changed: DispatchChangeResult): string[] {
  return resultForUndeliverableWorkflow(item, changed).issues;
}

function resumedChange(state: DispatchCheckpoint, taskFile: string): SoftwareChangeResult {
  if (!state.active?.prBody) throw new Error("dispatch checkpoint is missing the active pull request body");
  return {
    stage: "implementation",
    taskFile,
    taskCount: 0,
    valid: true,
    plan: { taskFile, taskCount: 0, valid: true, issues: [], failures: [] },
    branch: state.active.branch,
    prBody: state.active.prBody,
    reviewBlocking: false,
    issues: [],
    failedTasks: [],
    noopTasks: [],
  };
}

function deliveryBase(input: DispatchInput, mainBranch: string): string {
  return input.deliveryPolicy === "integrationBranch"
    ? input.integrationBranch
    : mainBranch;
}

function deliveryBaseRef(base: string): string {
  return `origin/${base}`;
}

function changeInput(
  input: DispatchInput,
  item: DispatchWorkItem,
  branch: string,
  baseBranch: string,
  taskGraphFile: string,
): SoftwareChangeInput {
  return {
    branch,
    baseBranch,
    intent: item.brief,
    outFile: item.taskFile ? undefined : taskGraphFile,
    repo: input.repo,
    taskFile: item.taskFile,
  };
}

function resultForWorkflowFailure(
  item: WorkItem,
  changed: DispatchChangeResult,
): DispatchItemResult {
  const stage = changed.stage === "planning" ? "plan" : "change";
  const issues = [`${stage} failed for ${item.id}`, ...changed.issues];
  if (changed.failedTasks.length) {
    issues.push(
      `implement reported failed tasks: ${changed.failedTasks.join(", ")}`,
    );
  }
  return {
    item: item.id,
    branch: changed.branch,
    prCreated: false,
    reviewBlocking: changed.stage === "planning" ? false : changed.reviewBlocking,
    issues,
  };
}

function resultForUndeliverableWorkflow(
  item: WorkItem,
  changed: DispatchChangeResult,
): DispatchItemResult {
  const issues = [...changed.issues];
  if (!changed.valid && issues.length === 0) {
    issues.push(`workflow result for ${item.id} was invalid`);
  }
  const reviewIssueRecorded = issues.some((issue) => issue.includes("review"));
  if (changed.reviewBlocking && !reviewIssueRecorded) {
    issues.push(`review blocked delivery for ${item.id}`);
  }
  if (changed.failedTasks.length) {
    issues.push(
      `implement reported failed tasks: ${changed.failedTasks.join(", ")}`,
    );
  }
  return {
    item: item.id,
    branch: changed.branch,
    prCreated: false,
    reviewBlocking: changed.reviewBlocking,
    issues,
  };
}

function workflowDeliverable(changed: DispatchChangeResult): boolean {
  return Boolean(
    changed.branch
    && changed.prBody
    && changed.valid
    && changed.issues.length === 0
    && !changed.reviewBlocking
    && changed.failedTasks.length === 0,
  );
}

function resultForDependencySkip(
  item: WorkItem,
  missing: string[],
): DispatchItemResult {
  return {
    item: item.id,
    prCreated: false,
    reviewBlocking: false,
    issues: [
      `skipped ${item.id} because dependencies were not delivered: ${missing.join(", ")}`,
    ],
  };
}

function resultForDelivery(
  item: WorkItem,
  changed: DispatchChangeResult,
  published: PublishResult,
): DispatchItemResult {
  const issues = [...changed.issues];
  if (changed.failedTasks.length) {
    issues.push(
      `implement reported failed tasks: ${changed.failedTasks.join(", ")}`,
    );
  }
  if (!published.push.ok) issues.push(`push failed: ${published.push.log}`);
  else if (!published.pr?.ok) {
    issues.push(`pr create failed: ${published.pr?.log ?? "not attempted"}`);
  }
  return {
    item: item.id,
    branch: changed.branch,
    prCreated: published.pr?.ok === true,
    reviewBlocking: changed.reviewBlocking,
    issues,
  };
}

function finalPullRequestBody(results: DispatchItemResult[]): string {
  const issues = results.flatMap((result) =>
    result.issues.map((issue) => `${result.item}: ${issue}`),
  );
  const issueList = issues.length
    ? issues.map((issue) => `- ${issue}`).join("\n")
    : "- none";
  return `## Dispatch issues\n${issueList}\n`;
}

function finalPullRequestResult(
  branch: string,
  base: string,
  created: AttemptResult,
): FinalPullRequestResult {
  const issues = created.ok
    ? []
    : [`pull request creation failed: ${created.log}`];
  return {
    branch,
    base,
    created: created.ok,
    issues,
  };
}

export async function verifyBase(repo: string): Promise<VerifyBaseResult> {
  const build = await evalGate("build", { cwd: repo });
  if (!build.ok) return { ok: false, log: build.log };

  const test = await evalGate("test", { cwd: repo });
  if (!test.ok) return { ok: false, log: test.log };

  return {
    ok: true,
    log: [build.log, test.log].filter(Boolean).join("\n"),
  };
}

/**
 * Orders work by dependency, merges each verified item into the selected delivery
 * base, and verifies that base before continuing. Integration-branch delivery opens
 * one final pull request to main without merging it.
 */
async function runDispatch(
  ctx: SigilContext,
  input: DispatchInput,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const backlogContents = await readFile(input.backlogFile, "utf8");
  const backlog = validateBacklog(JSON.parse(backlogContents));
  const items = orderItems(backlog) as DispatchWorkItem[];
  const results: DispatchItemResult[] = [];
  const runSoftwareChange = options.softwareChange ?? softwareChange;
  const runPublish = options.publish ?? publish;
  const runMerge = options.merge ?? mergePr;
  const runCreatePullRequest = options.createPullRequest ?? createPr;
  const runVerifyBase = options.verifyBase ?? verifyBase;
  const runRepairChange = options.repairChange ?? repairExistingChange;
  const runRecoverChange = options.recoverChange ?? recoverInterruptedSoftwareChange;
  const wait = options.wait ?? delay;
  const prepareIntegrationBranch =
    options.prepareIntegrationBranch ?? checkoutIntegrationBranch;
  const config = loadConfig(input.repo);
  const mainBranch = config.implement.baseBranch;
  const baseBranch = deliveryBase(input, mainBranch);
  const implementationBase = deliveryBaseRef(baseBranch);
  const checkpointFile = ctx.artifacts.path("dispatch-state.json");
  const state = await loadDispatchCheckpoint(checkpointFile, {
    repository: resolve(input.repo),
    backlogFile: resolve(input.backlogFile),
    backlogDigest: dispatchBacklogDigest(backlogContents),
    deliveryPolicy: input.deliveryPolicy,
    deliveryBase: baseBranch,
  });
  const delivered = state.delivered.map((item) => item.id);
  const deliveredSet = new Set(delivered);

  if (input.deliveryPolicy === "integrationBranch") {
    await prepareIntegrationBranch(
      input.repo,
      input.integrationBranch,
      mainBranch,
    );
  }

  for (const item of items) {
    if (deliveredSet.has(item.id)) continue;

    const missingDependencies = item.dependsOn.filter(
      (dependency) => !deliveredSet.has(dependency),
    );
    if (missingDependencies.length) {
      results.push(resultForDependencySkip(item, missingDependencies));
      continue;
    }

    const branch = itemBranch(input.repo, item);
    const itemContext = ctx.fork({
      artifactRoot: ctx.artifacts.path(join("dispatch", item.id)),
      operationPath: `dispatch/${item.id}`,
    });
    const taskFile = state.active?.id === item.id
      ? state.active.taskFile
      : itemContext.artifacts.path("task-graph.json");
    const currentBaseCommit = await currentCommit(input.repo, deliveryBaseRef(baseBranch));
    const completedVerificationValid = state.operation?.inputDigest === dispatchValueDigest({
      base: baseBranch,
      commit: currentBaseCommit,
    });
    if (state.active?.id === item.id
      && state.active.stage === "verify-base"
      && state.operation?.type === "verify-base"
      && state.operation.status === "completed"
      && completedVerificationValid) {
      delivered.push(item.id);
      deliveredSet.add(item.id);
      state.delivered.push({
        id: item.id,
        commit: await currentCommit(input.repo, deliveryBaseRef(baseBranch)),
      });
      state.active = undefined;
      state.operation = undefined;
      await writeDispatchCheckpoint(checkpointFile, state);
      continue;
    }
    if (state.active?.stage === "verify-base"
      && state.operation?.type === "verify-base"
      && state.operation.status === "completed"
      && !completedVerificationValid) {
      state.operation.status = "running";
      await writeDispatchCheckpoint(checkpointFile, state);
    }
    let changed: SoftwareChangeResult;
    const activeStage = state.active?.id === item.id ? state.active.stage : undefined;
    const resumedStage = completedDeliveryStage(activeStage, state);

    if ((activeStage === "software-change" || activeStage === "repair")
      && state.operation?.status === "completed"
      && state.operation.outputArtifact) {
      changed = JSON.parse(await readFile(state.operation.outputArtifact, "utf8")) as SoftwareChangeResult;
    } else if (resumedStage === "publish" || resumedStage === "merge" || resumedStage === "verify-base") {
      changed = resumedChange(state, taskFile);
    } else if (resumedStage === "repair") {
      changed = await runRepairChange(itemContext, {
        repo: input.repo,
        branch,
        baseBranch: implementationBase,
        taskFile,
        item,
        issues: state.active?.issues ?? [],
        providerSessionId: state.operation?.agent?.providerSessionId,
      });
      await completeOperation(checkpointFile, state, itemContext, {
        name: "review-repair",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
      });
    } else if (resumedStage === "software-change") {
      changed = await runRecoverChange(itemContext, {
        repo: input.repo,
        branch,
        baseBranch: implementationBase,
        taskFile,
        item,
        issues: state.active?.issues ?? [],
        providerSessionId: state.operation?.agent?.providerSessionId,
      });
      await completeOperation(checkpointFile, state, itemContext, {
        name: "implementation-task",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
      });
    } else {
      state.active = { id: item.id, branch, taskFile, stage: "software-change", issues: [] };
      const operationInput = changeInput(input, item, branch, implementationBase, taskFile);
      await beginOperation(checkpointFile, state, itemContext, {
        type: "implementation/task",
        name: "implementation-task",
        value: operationInput,
        repo: input.repo,
        repairBudget: config.implement.repairLimit,
      });
      changed = await itemContext.run(
        runSoftwareChange,
        operationInput,
      );
      await completeOperation(checkpointFile, state, itemContext, {
        name: "implementation-task",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
      });
    }

    if (!changed.branch || !changed.prBody) {
      state.active = { id: item.id, branch, taskFile, stage: "repair", issues: resultForWorkflowFailure(item, changed).issues };
      await writeDispatchCheckpoint(checkpointFile, state);
      results.push(resultForWorkflowFailure(item, changed));
      return { delivered, stoppedAt: item.id, results };
    }
    if (!workflowDeliverable(changed)) {
      const actionableFindings = changeIssues(item, changed);
      await itemContext.artifacts.write(
        "actionable-findings.json",
        `${JSON.stringify({ findings: actionableFindings }, null, 2)}\n`,
      );
      await beginOperation(checkpointFile, state, itemContext, {
        type: "review/repair",
        name: "review-repair",
        value: actionableFindings,
        repo: input.repo,
        repairBudget: config.implement.repairLimit,
      });
      state.active = { id: item.id, branch, taskFile, stage: "repair", issues: actionableFindings };
      await writeDispatchCheckpoint(checkpointFile, state);
      changed = await runRepairChange(itemContext, {
        repo: input.repo,
        branch,
        baseBranch: implementationBase,
        taskFile,
        item,
        issues: state.active.issues,
      });
      await completeOperation(checkpointFile, state, itemContext, {
        name: "review-repair",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
      });
      if (!workflowDeliverable(changed)) {
        state.active.issues = changeIssues(item, changed);
        await writeDispatchCheckpoint(checkpointFile, state);
        results.push(resultForUndeliverableWorkflow(item, changed));
        return { delivered, stoppedAt: item.id, results };
      }
    }

    let published: PublishResult = { push: { ok: true, log: "resumed" }, pr: { ok: true, log: "resumed" } };
    if (resumedStage !== "merge" && resumedStage !== "verify-base") {
      state.active = { id: item.id, branch, taskFile, stage: "publish", issues: [], prBody: changed.prBody };
      await beginOperation(checkpointFile, state, itemContext, {
        type: "publish",
        name: "publish",
        value: { branch: changed.branch, base: baseBranch, body: changed.prBody },
        repo: input.repo,
        repairBudget: config.implement.repairLimit,
      });
      published = await retryResult(
        () => runPublish(input.repo, {
          branch: changed.branch!,
          title: changed.branch!,
          body: changed.prBody!,
          base: baseBranch,
        }),
        (value) => value.push.ok && value.pr?.ok === true,
        config.implement.repairLimit,
        wait,
      );
      await completeOperation(checkpointFile, state, itemContext, {
        name: "publish",
        value: published,
        repo: input.repo,
        failed: !(published.push.ok && published.pr?.ok === true),
      });
    }
    const result = resultForDelivery(item, changed, published);
    results.push(result);
    if (!result.prCreated || result.issues.length > 0) {
      if (state.active) state.active.issues = result.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { delivered, stoppedAt: item.id, results };
    }

    let merged: AttemptResult = { ok: true, log: "resumed" };
    if (resumedStage !== "verify-base") {
      if (state.active) state.active.stage = "merge";
      await beginOperation(checkpointFile, state, itemContext, {
        type: "merge",
        name: "merge",
        value: { branch: changed.branch, base: baseBranch },
        repo: input.repo,
        repairBudget: config.implement.repairLimit,
      });
      merged = await retryResult(
        () => runMerge(input.repo, { branch: changed.branch!, base: baseBranch }),
        (value) => value.ok,
        config.implement.repairLimit,
        wait,
      );
      await completeOperation(checkpointFile, state, itemContext, {
        name: "merge",
        value: merged,
        repo: input.repo,
        failed: !merged.ok,
      });
    }
    if (!merged.ok) {
      result.issues.push(`merge failed: ${merged.log}`);
      if (state.active) state.active.issues = result.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { delivered, stoppedAt: item.id, results };
    }

    if (state.active) state.active.stage = "verify-base";
    await beginOperation(checkpointFile, state, itemContext, {
      type: "verify-base",
      name: "verify-base",
      value: {
        base: baseBranch,
        commit: await currentCommit(input.repo, deliveryBaseRef(baseBranch)),
      },
      repo: input.repo,
      repairBudget: config.implement.repairLimit,
    });
    const verified = await retryResult(
      () => runVerifyBase(input.repo),
      (value) => value.ok,
      config.implement.repairLimit,
      wait,
    );
    if (state.operation) {
      state.operation.gates.verifyBase = {
        status: verified.ok ? "passed" : "failed",
        inputDigest: state.operation.inputDigest,
        evidence: verified.log,
      };
    }
    await completeOperation(checkpointFile, state, itemContext, {
      name: "verify-base",
      value: verified,
      repo: input.repo,
      failed: !verified.ok,
    });
    if (!verified.ok) {
      result.issues.push(`base verification failed: ${verified.log}`);
      if (state.active) state.active.issues = result.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { delivered, stoppedAt: item.id, results };
    }

    delivered.push(item.id);
    deliveredSet.add(item.id);
    state.delivered.push({ id: item.id, commit: await currentCommit(input.repo, deliveryBaseRef(baseBranch)) });
    state.active = undefined;
    state.operation = undefined;
    await writeDispatchCheckpoint(checkpointFile, state);
  }

  if (input.deliveryPolicy === "integrationBranch") {
    const created = await retryResult(
      () => runCreatePullRequest(input.repo, {
        title: backlog.mission,
        body: finalPullRequestBody(results),
        base: mainBranch,
        head: input.integrationBranch,
      }),
      (value) => value.ok,
      config.implement.repairLimit,
      wait,
    );
    const finalPullRequest = finalPullRequestResult(
      input.integrationBranch,
      mainBranch,
      created,
    );
    if (finalPullRequest.created && input.finalAction === "mergeWhenGreen") {
      const merged = await retryResult(
        () => runMerge(input.repo, { branch: input.integrationBranch, base: mainBranch }),
        (value) => value.ok,
        config.implement.repairLimit,
        wait,
      );
      finalPullRequest.merged = merged.ok;
      if (!merged.ok) finalPullRequest.issues.push(`final merge failed: ${merged.log}`);

      if (merged.ok && input.productionGate) {
        const production = await ctx.evals(input.productionGate);
        finalPullRequest.productionVerified = !production.skipped && production.ok;
        if (production.skipped) finalPullRequest.issues.push(`production gate ${input.productionGate} is not configured`);
        else if (!production.ok) finalPullRequest.issues.push(`production verification failed: ${production.log}`);
      }
    }
    return {
      delivered,
      stoppedAt: finalPullRequest.issues.length === 0 ? undefined : "final-pull-request",
      results,
      finalPullRequest,
    };
  }

  return { delivered, results };
}

function completedDeliveryStage(
  active: DispatchActiveItem["stage"] | undefined,
  state: DispatchCheckpoint,
): DispatchActiveItem["stage"] | undefined {
  if (state.operation?.status !== "completed") return active;
  if (active === "publish" && state.operation.type === "publish") return "merge";
  if (active === "merge" && state.operation.type === "merge") return "verify-base";
  return active;
}

export function createDispatch(options: DispatchOptions = {}) {
  return sigil<DispatchInput, DispatchResult>("dispatch", (ctx, input) =>
    runDispatch(ctx, input, options));
}

export const dispatch = createDispatch();

export function dispatchWithOptions(
  input: DispatchInput,
  options: DispatchOptions,
  ctx?: SigilContext,
): Promise<DispatchResult> {
  return createDispatch(options)(input, ctx);
}
