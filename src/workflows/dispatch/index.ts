import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadConfig, type SigilConfig } from "../../config.js";
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
  type DispatchStageEvidence,
  readDispatchRuntime,
} from "./state.js";
import { initializeDispatchProfiles } from "./initialization.js";
import { validateTaskGraph, taskGraphDigest } from "../../contracts/task-graph.js";

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
  status?: "completed" | "stopped" | "waiting";
  retryable?: boolean;
  delivered: string[];
  stoppedAt?: string;
  results: DispatchItemResult[];
  finalPullRequest?: FinalPullRequestResult;
};
export type VerifyBaseResult = { ok: boolean; log: string };

export type DispatchOptions = {
  initialize?: (ctx: SigilContext, config: SigilConfig) => Promise<void>;
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
  if (state.operation && state.operation.status === "completed") {
    state.operations ??= [];
    if (!state.operations.some((operation) => operation.id === state.operation!.id)) state.operations.push(state.operation);
  }
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
  input: {
    name: string; value: unknown; repo: string; failed?: boolean;
    status?: DispatchOperation["status"];
    failure?: DispatchOperation["failure"];
    evidence?: DispatchStageEvidence;
  },
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
  state.operation.status = input.status ?? (input.failed ? "failed" : "completed");
  state.operation.failure = input.failure;
  state.operation.evidence = input.evidence;
  await writeDispatchCheckpoint(checkpointFile, state);
}

function completedOperation(state: DispatchCheckpoint, type: DispatchOperationType, value: unknown): DispatchOperation | undefined {
  const digest = dispatchValueDigest(value);
  return [state.operation, ...(state.operations ?? [])].find(
    (operation) => operation?.type === type && operation.status === "completed" && operation.inputDigest === digest,
  );
}

function archiveOperation(state: DispatchCheckpoint): void {
  if (!state.operation) return;
  state.operations ??= [];
  if (!state.operations.some((operation) => operation.id === state.operation!.id)) state.operations.push(state.operation);
}

function prEvidence(result: AttemptResult | null | undefined): DispatchStageEvidence | undefined {
  const evidence = result?.evidence;
  return evidence ? { kind: "remote-pr", number: evidence.number, head: evidence.head, base: evidence.base,
    headCommit: evidence.headCommit, state: evidence.state, mergedCommit: evidence.mergedCommit, url: evidence.url } : undefined;
}

function mergeEvidence(result: AttemptResult, head: string, base: string): DispatchStageEvidence | undefined {
  return result.evidence ? { kind: "merge", head, base, headCommit: result.evidence.headCommit,
    mergedCommit: result.evidence.mergedCommit } : undefined;
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
    const event = JSON.parse(line) as { stage?: string; details?: { gate?: string; outcome?: string; command?: string } };
    const details = event.details ?? {};
    if (event.stage !== "gate-completed" || !details.gate) continue;
    const status = details.outcome === "passed" || details.outcome === "failed" ? details.outcome : "skipped";
    gates[details.gate] = { status, inputDigest, evidence: details.command };
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
  canonicalGraphFile: string,
  checkpointFile: string,
  resume = false,
): SoftwareChangeInput {
  return {
    branch,
    baseBranch,
    intent: item.brief,
    outFile: item.taskFile ? undefined : taskGraphFile,
    repo: input.repo,
    taskFile: item.taskFile,
    canonicalGraphFile,
    checkpointFile,
    resume,
  };
}

function interruption(changed: DispatchChangeResult): DispatchOperation["failure"] | undefined {
  const evidence = changed.issues.join("\n");
  if (/capacity (?:blocked|exhausted)|no eligible profile/i.test(evidence)) return { kind: "capacity", code: "capacity_exhausted", evidence };
  if (/provider interruption|resume with the implementation checkpoint/i.test(evidence)) return { kind: "provider-interruption", evidence };
  return undefined;
}

async function linkImplementationArtifacts(state: DispatchCheckpoint, repo: string): Promise<void> {
  const active = state.active;
  if (!active?.canonicalGraphFile || !active.implementationCheckpointFile || !state.operation) return;
  try {
    const graph = validateTaskGraph(JSON.parse(await readFile(active.canonicalGraphFile, "utf8")), { repoRoot: repo });
    const digest = taskGraphDigest(graph);
    active.graphDigest = digest;
    state.operation.implementation = {
      canonicalGraphFile: active.canonicalGraphFile,
      graphDigest: digest,
      checkpointFile: active.implementationCheckpointFile,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  const starting = !existsSync(checkpointFile);
  const state = await loadDispatchCheckpoint(checkpointFile, {
    repository: resolve(input.repo),
    backlogFile: resolve(input.backlogFile),
    backlogDigest: dispatchBacklogDigest(backlogContents),
    deliveryPolicy: input.deliveryPolicy,
    deliveryBase: baseBranch,
  });
  if (starting) {
    await options.initialize?.(ctx, config);
    await writeDispatchCheckpoint(checkpointFile, state);
  }
  const delivered = state.delivered.map((item) => item.id);
  const deliveredSet = new Set(delivered);

  const recoveringImplementation = state.operation?.status === "recovering"
    && state.operation.type === "implementation/task"
    && state.active?.stage === "software-change";
  if (input.deliveryPolicy === "integrationBranch" && !recoveringImplementation) {
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
    const canonicalGraphFile = state.active?.id === item.id && state.active.canonicalGraphFile
      ? state.active.canonicalGraphFile
      : itemContext.artifacts.path("implementation/task-graph.json");
    const implementationCheckpointFile = state.active?.id === item.id && state.active.implementationCheckpointFile
      ? state.active.implementationCheckpointFile
      : itemContext.artifacts.path("implementation/checkpoint.json");
    const currentBaseCommit = await currentCommit(input.repo, deliveryBaseRef(baseBranch));
    const completedVerificationValid = state.operation?.inputDigest === dispatchValueDigest({
      base: baseBranch,
      commit: currentBaseCommit,
      gateInput: "build,test",
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
      archiveOperation(state);
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
    let resumedStage = completedDeliveryStage(activeStage, state);

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
        canonicalGraphFile,
        checkpointFile: implementationCheckpointFile,
      });
      const failure = interruption(changed);
      await completeOperation(checkpointFile, state, itemContext, {
        name: "implementation-task",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
        status: failure?.kind === "capacity" ? "capacity-blocked" : failure ? "interrupted" : undefined,
        failure,
      });
    } else {
      state.active = {
        id: item.id, branch, taskFile, stage: "software-change", issues: [],
        canonicalGraphFile, implementationCheckpointFile,
      };
      const operationInput = changeInput(input, item, branch, implementationBase, taskFile, canonicalGraphFile, implementationCheckpointFile);
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
      await linkImplementationArtifacts(state, input.repo);
      const failure = interruption(changed);
      await completeOperation(checkpointFile, state, itemContext, {
        name: "implementation-task",
        value: changed,
        repo: input.repo,
        failed: !workflowDeliverable(changed),
        status: failure?.kind === "capacity" ? "capacity-blocked" : failure ? "interrupted" : undefined,
        failure,
      });
    }

    const operationFailure = interruption(changed);
    if (operationFailure?.kind === "capacity") {
      if (state.active) state.active.issues = changed.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { status: "waiting", retryable: true, delivered, stoppedAt: item.id, results };
    }
    if (operationFailure?.kind === "provider-interruption") {
      if (state.active) state.active.issues = changed.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { status: "stopped", delivered, stoppedAt: item.id, results };
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

    const deliveryCommit = changed.branch ? await currentCommit(input.repo, changed.branch) : undefined;
    const expectedPublishInput = { branch: changed.branch, base: baseBranch, body: changed.prBody, commit: deliveryCommit };
    if (activeStage === "publish" && state.operation?.type === "publish"
      && state.operation.status === "completed"
      && state.operation.inputDigest !== dispatchValueDigest(expectedPublishInput)) resumedStage = "publish";
    const expectedMergeInput = { branch: changed.branch, base: baseBranch, commit: deliveryCommit };
    if (activeStage === "merge" && state.operation?.type === "merge"
      && state.operation.status === "completed"
      && state.operation.inputDigest !== dispatchValueDigest(expectedMergeInput)) resumedStage = "merge";

    let published: PublishResult = { push: { ok: true, log: "resumed" }, pr: { ok: true, log: "resumed" } };
    if (resumedStage !== "merge" && resumedStage !== "verify-base") {
      state.active = { id: item.id, branch, taskFile, stage: "publish", issues: [], prBody: changed.prBody };
      await beginOperation(checkpointFile, state, itemContext, {
        type: "publish",
        name: "publish",
        value: expectedPublishInput,
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
        evidence: prEvidence(published.pr),
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
        value: expectedMergeInput,
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
        evidence: mergeEvidence(merged, changed.branch!, baseBranch),
      });
    }
    if (!merged.ok) {
      result.issues.push(`merge failed: ${merged.log}`);
      if (state.active) state.active.issues = result.issues;
      await writeDispatchCheckpoint(checkpointFile, state);
      return { delivered, stoppedAt: item.id, results };
    }

    if (state.active) state.active.stage = "verify-base";
    const verificationInput = {
      base: baseBranch,
      commit: await currentCommit(input.repo, deliveryBaseRef(baseBranch)),
      gateInput: "build,test",
    };
    await beginOperation(checkpointFile, state, itemContext, {
      type: "verify-base",
      name: "verify-base",
      value: verificationInput,
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
      evidence: verificationInput.commit ? { kind: "verification", commit: verificationInput.commit,
        gateInput: verificationInput.gateInput, log: verified.log } : undefined,
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
    archiveOperation(state);
    state.operation = undefined;
    await writeDispatchCheckpoint(checkpointFile, state);
  }

  if (input.deliveryPolicy === "integrationBranch") {
    const finalBody = finalPullRequestBody(results);
    const integrationCommit = await currentCommit(input.repo, input.integrationBranch)
      ?? await currentCommit(input.repo, `origin/${input.integrationBranch}`);
    const finalPrInput = { title: backlog.mission, body: finalBody, base: mainBranch,
      head: input.integrationBranch, headCommit: integrationCommit };
    let created: AttemptResult;
    const priorPr = completedOperation(state, "final-pull-request", finalPrInput);
    if (priorPr?.evidence?.kind === "remote-pr" && priorPr.evidence.head === input.integrationBranch
      && priorPr.evidence.base === mainBranch && (!integrationCommit || !priorPr.evidence.headCommit || priorPr.evidence.headCommit === integrationCommit)) {
      created = { ok: true, log: "resumed final pull request", evidence: {
        number: priorPr.evidence.number ?? 0, head: priorPr.evidence.head, base: priorPr.evidence.base,
        state: priorPr.evidence.state, headCommit: priorPr.evidence.headCommit,
        mergedCommit: priorPr.evidence.mergedCommit, url: priorPr.evidence.url,
      } };
    } else {
      await beginOperation(checkpointFile, state, ctx, { type: "final-pull-request", name: "final-pull-request",
        value: finalPrInput, repo: input.repo, repairBudget: config.implement.repairLimit });
      created = await retryResult(
        () => runCreatePullRequest(input.repo, finalPrInput),
        (value) => value.ok,
        config.implement.repairLimit,
        wait,
      );
      await completeOperation(checkpointFile, state, ctx, { name: "final-pull-request", value: created,
        repo: input.repo, failed: !created.ok, evidence: prEvidence(created) });
    }
    const finalPullRequest = finalPullRequestResult(
      input.integrationBranch,
      mainBranch,
      created,
    );
    if (finalPullRequest.created && input.finalAction === "mergeWhenGreen") {
      const finalMergeInput = { branch: input.integrationBranch, base: mainBranch, headCommit: integrationCommit };
      let merged: AttemptResult;
      const priorMerge = completedOperation(state, "final-merge", finalMergeInput);
      if (priorMerge?.evidence?.kind === "merge") {
        merged = { ok: true, log: "resumed final merge", evidence: {
          number: created.evidence?.number ?? 0, head: priorMerge.evidence.head, base: priorMerge.evidence.base,
          state: "MERGED", headCommit: priorMerge.evidence.headCommit,
          mergedCommit: priorMerge.evidence.mergedCommit,
        } };
      } else {
        await beginOperation(checkpointFile, state, ctx, { type: "final-merge", name: "final-merge",
          value: finalMergeInput, repo: input.repo, repairBudget: config.implement.repairLimit });
        merged = await retryResult(
          () => runMerge(input.repo, { branch: input.integrationBranch, base: mainBranch }),
          (value) => value.ok,
          config.implement.repairLimit,
          wait,
        );
        await completeOperation(checkpointFile, state, ctx, { name: "final-merge", value: merged,
          repo: input.repo, failed: !merged.ok, evidence: mergeEvidence(merged, input.integrationBranch, mainBranch) });
      }
      finalPullRequest.merged = merged.ok;
      if (!merged.ok) finalPullRequest.issues.push(`final merge failed: ${merged.log}`);

      if (merged.ok && input.productionGate) {
        const productionCommit = merged.evidence?.mergedCommit
          ?? await currentCommit(input.repo, deliveryBaseRef(mainBranch));
        const productionInput = { commit: productionCommit, gate: input.productionGate };
        const priorProduction = completedOperation(state, "production-verification", productionInput);
        let production: Awaited<ReturnType<SigilContext["evals"]>>;
        if (priorProduction?.evidence?.kind === "verification") {
          production = { ok: true, skipped: false, log: priorProduction.evidence.log };
        } else {
          await beginOperation(checkpointFile, state, ctx, { type: "production-verification", name: "production-verification",
            value: productionInput, repo: input.repo, repairBudget: config.implement.repairLimit });
          production = await ctx.evals(input.productionGate);
          await completeOperation(checkpointFile, state, ctx, { name: "production-verification", value: production,
            repo: input.repo, failed: production.skipped || !production.ok,
            evidence: productionCommit ? { kind: "verification", commit: productionCommit,
              gateInput: input.productionGate, log: production.log ?? "" } : undefined });
        }
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

export const dispatch = createDispatch({ initialize: initializeDispatchProfiles });

export function dispatchWithOptions(
  input: DispatchInput,
  options: DispatchOptions,
  ctx?: SigilContext,
): Promise<DispatchResult> {
  return createDispatch(options)(input, ctx);
}
