import { loadConfig } from "../../config.js";
import type { WorkItem } from "../../contracts/backlog.js";
import type { SigilContext } from "../../context.js";
import { commitAll, git } from "../../git.js";
import { runGateSet } from "../../verification.js";
import { review } from "../software-change/review/index.js";
import type { SoftwareChangeResult } from "../software-change/workflow.js";
import { dispatchPrompts } from "./prompts.js";
import type { WorkflowFailure } from "../../recovery/index.js";
import { softwareChange } from "../software-change/workflow.js";

export type ExistingBranchRepairInput = {
  repo: string;
  branch: string;
  baseBranch: string;
  taskFile: string;
  item: WorkItem;
  issues: string[];
  failures?: WorkflowFailure[];
  providerSessionId?: string;
  canonicalGraphFile?: string;
  checkpointFile?: string;
};

async function checkoutExistingBranch(repo: string, branch: string): Promise<void> {
  const checked = await git(repo, ["checkout", branch]);
  if (checked.code !== 0) throw new Error(checked.log || `failed to checkout ${branch}`);
}

async function verifyAll(ctx: SigilContext): Promise<string | undefined> {
  const verification = await runGateSet(ctx, ["build", "test", "e2e", "verify"]);
  const configured = verification.gates.filter((gate) => !gate.result.skipped);
  if (!configured.length || verification.ok) return undefined;
  return verification.evidence;
}

function repairedResult(
  input: ExistingBranchRepairInput,
  issues: string[],
): SoftwareChangeResult {
  const valid = issues.length === 0;
  return {
    stage: "implementation",
    taskFile: input.taskFile,
    taskCount: 0,
    valid,
    plan: { taskFile: input.taskFile, taskCount: 0, valid: true, issues: [], failures: [] },
    branch: input.branch,
    prBody: `## Issues\n${valid ? "- none" : issues.map((issue) => `- ${issue}`).join("\n")}\n`,
    reviewBlocking: !valid,
    issues,
    failedTasks: [],
    noopTasks: [],
  };
}

export async function repairExistingChange(
  ctx: SigilContext,
  input: ExistingBranchRepairInput,
): Promise<SoftwareChangeResult> {
  const config = loadConfig(input.repo);
  const attempts = new Map<string, number>();
  let issues = [...input.issues];
  try {
    await checkoutExistingBranch(input.repo, input.branch);
  } catch (error) {
    return repairedResult(input, [...input.issues, error instanceof Error ? error.message : String(error)]);
  }

  while (issues.length) {
    const exhausted = issues.filter((issue) => (
      attempts.get(recoveryIdentity(issue, input.failures)) ?? 0
    ) >= config.implement.repairLimit);
    if (exhausted.length) return repairedResult(input, exhausted.map((issue) => `recovery exhausted: ${issue}`));
    for (const issue of issues) {
      const identity = recoveryIdentity(issue, input.failures);
      attempts.set(identity, (attempts.get(identity) ?? 0) + 1);
    }

    await using coder = ctx.agent(config.implement.coder, {
      resumeSessionId: input.providerSessionId,
    });
    await coder.prompt(dispatchPrompts.repair({
      ITEM_ID: input.item.id,
      BRIEF: input.item.brief,
      TASK_FILE: input.taskFile,
      EVIDENCE: issues.join("\n\n"),
    }));

    const gateFailure = await verifyAll(ctx);
    if (gateFailure) {
      issues = [gateFailure];
      continue;
    }

    const reviewed = await ctx.run(review, {
      repo: input.repo,
      base: input.baseBranch,
      autofix: true,
      context: input.item.brief,
    });
    issues = reviewed.valid && reviewed.issues.length === 0
      ? []
      : [...reviewed.issues, ...reviewed.structuredFindings?.map((finding) => finding.requiredChange) ?? []];
  }

  const commit = await commitAll(input.repo, `${input.item.id}: recovery repairs`);
  if (commit.status === "failed") return repairedResult(input, [commit.log]);
  return repairedResult(input, []);
}

export function recoveryIdentity(issue: string, failures: WorkflowFailure[] = []): string {
  const failure = failures.find((candidate) => candidate.evidence === issue);
  return failure?.provider?.fingerprint ?? `issue:${issue.trim().replace(/\s+/g, " ")}`;
}

export async function recoverInterruptedSoftwareChange(
  ctx: SigilContext,
  input: ExistingBranchRepairInput,
): Promise<SoftwareChangeResult> {
  if (!input.canonicalGraphFile || !input.checkpointFile) {
    throw new Error("dispatch reconciliation required: precise implementation artifacts are missing");
  }
  return ctx.run(softwareChange, {
    repo: input.repo,
    intent: input.item.brief,
    taskFile: input.taskFile,
    branch: input.branch,
    baseBranch: input.baseBranch,
    canonicalGraphFile: input.canonicalGraphFile,
    checkpointFile: input.checkpointFile,
    resume: true,
  });
}
