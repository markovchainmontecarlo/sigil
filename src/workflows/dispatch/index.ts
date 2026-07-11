import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../../config.js";
import { orderItems, validateBacklog, type WorkItem } from "../../contracts/backlog.js";
import { evalGate } from "../../gate.js";
import {
  checkoutIntegrationBranch,
  createPr,
  mergePr,
  publish,
  type AttemptResult,
  type PublishResult,
} from "../../git.js";
import { artifactDir } from "../../paths.js";
import {
  softwareChange,
  type SoftwareChangeInput,
  type SoftwareChangeResult,
} from "../software-change/workflow.js";

export type DeliveryPolicy = "mergeWhenGreen" | "integrationBranch";
type DispatchBaseInput = { backlogFile: string; repo: string };
export type DispatchInput = DispatchBaseInput & (
  | { deliveryPolicy: "mergeWhenGreen" }
  | { deliveryPolicy: "integrationBranch"; integrationBranch: string }
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function taskGraphFile(repo: string, item: WorkItem): string {
  return join(artifactDir(repo), "dispatch", item.id, "task-graph.json");
}

function itemBranch(repo: string, item: WorkItem): string {
  return `${loadConfig(repo).implement.branchPrefix}${item.id}`;
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
): SoftwareChangeInput {
  return {
    branch,
    baseBranch,
    intent: item.brief,
    outFile: item.taskFile ? undefined : taskGraphFile(input.repo, item),
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
export async function dispatch(
  input: DispatchInput,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const backlog = validateBacklog(await readJson(input.backlogFile));
  const items = orderItems(backlog) as DispatchWorkItem[];
  const delivered: string[] = [];
  const deliveredSet = new Set<string>();
  const results: DispatchItemResult[] = [];
  const runSoftwareChange = options.softwareChange ?? softwareChange;
  const runPublish = options.publish ?? publish;
  const runMerge = options.merge ?? mergePr;
  const runCreatePullRequest = options.createPullRequest ?? createPr;
  const runVerifyBase = options.verifyBase ?? verifyBase;
  const prepareIntegrationBranch =
    options.prepareIntegrationBranch ?? checkoutIntegrationBranch;
  const mainBranch = loadConfig(input.repo).implement.baseBranch;
  const baseBranch = deliveryBase(input, mainBranch);
  const implementationBase = deliveryBaseRef(baseBranch);

  if (input.deliveryPolicy === "integrationBranch") {
    await prepareIntegrationBranch(
      input.repo,
      input.integrationBranch,
      mainBranch,
    );
  }

  for (const item of items) {
    const missingDependencies = item.dependsOn.filter(
      (dependency) => !deliveredSet.has(dependency),
    );
    if (missingDependencies.length) {
      results.push(resultForDependencySkip(item, missingDependencies));
      continue;
    }

    const branch = itemBranch(input.repo, item);
    const changed = await runSoftwareChange(
      changeInput(input, item, branch, implementationBase),
    );
    if (!changed.branch || !changed.prBody) {
      results.push(resultForWorkflowFailure(item, changed));
      return { delivered, stoppedAt: item.id, results };
    }
    if (!workflowDeliverable(changed)) {
      results.push(resultForUndeliverableWorkflow(item, changed));
      return { delivered, stoppedAt: item.id, results };
    }

    const published = await runPublish(input.repo, {
      branch: changed.branch,
      title: changed.branch,
      body: changed.prBody,
      base: baseBranch,
    });
    const result = resultForDelivery(item, changed, published);
    results.push(result);
    if (!result.prCreated || result.issues.length > 0) {
      return { delivered, stoppedAt: item.id, results };
    }

    const merged = await runMerge(input.repo, {
      branch: changed.branch,
      base: baseBranch,
    });
    if (!merged.ok) {
      result.issues.push(`merge failed: ${merged.log}`);
      return { delivered, stoppedAt: item.id, results };
    }

    const verified = await runVerifyBase(input.repo);
    if (!verified.ok) {
      result.issues.push(`base verification failed: ${verified.log}`);
      return { delivered, stoppedAt: item.id, results };
    }

    delivered.push(item.id);
    deliveredSet.add(item.id);
  }

  if (input.deliveryPolicy === "integrationBranch") {
    const created = await runCreatePullRequest(input.repo, {
      title: backlog.mission,
      body: finalPullRequestBody(results),
      base: mainBranch,
      head: input.integrationBranch,
    });
    const finalPullRequest = finalPullRequestResult(
      input.integrationBranch,
      mainBranch,
      created,
    );
    return {
      delivered,
      stoppedAt: finalPullRequest.created ? undefined : "final-pull-request",
      results,
      finalPullRequest,
    };
  }

  return { delivered, results };
}
