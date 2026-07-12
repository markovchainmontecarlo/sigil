import { loadConfig } from "../../config.js";
import type { WorkItem } from "../../contracts/backlog.js";
import type { SigilContext } from "../../context.js";
import { commitAll, git } from "../../git.js";
import { runGateSet } from "../../verification.js";
import { review } from "../software-change/review/index.js";
import type { SoftwareChangeResult } from "../software-change/workflow.js";
import { dispatchPrompts } from "./prompts.js";
import { plan } from "../software-change/planning/index.js";
import { access } from "node:fs/promises";

export type ExistingBranchRepairInput = {
  repo: string;
  branch: string;
  baseBranch: string;
  taskFile: string;
  item: WorkItem;
  issues: string[];
  providerSessionId?: string;
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
    const exhausted = issues.filter((issue) => (attempts.get(issue) ?? 0) >= config.implement.repairLimit);
    if (exhausted.length) return repairedResult(input, exhausted.map((issue) => `recovery exhausted: ${issue}`));
    for (const issue of issues) attempts.set(issue, (attempts.get(issue) ?? 0) + 1);

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

export async function recoverInterruptedSoftwareChange(
  ctx: SigilContext,
  input: ExistingBranchRepairInput,
): Promise<SoftwareChangeResult> {
  await ensureTaskFile(ctx, input);
  await ensureActiveBranch(input.repo, input.branch, input.baseBranch);
  const reviewEvidence = await readReviewEvidence(ctx);
  return repairExistingChange(ctx, {
    ...input,
    issues: [
      ...input.issues,
      ...reviewEvidence,
      "Continue the interrupted implementation from the persisted task graph and current repository state.",
    ],
  });
}

async function readReviewEvidence(ctx: SigilContext): Promise<string[]> {
  const names = [
    "review/correctness-output.json",
    "review/test-integrity-output.json",
    "review/synthesis-output.json",
    "review/repair-input.json",
    "review/post-review-verification-output.json",
  ];
  const evidence: string[] = [];
  for (const name of names) {
    try {
      evidence.push(`${name}:\n${await ctx.artifacts.read(name)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return evidence;
}

async function ensureTaskFile(ctx: SigilContext, input: ExistingBranchRepairInput): Promise<void> {
  try {
    await access(input.taskFile);
    return;
  } catch {
    const planned = await ctx.run(plan, {
      repo: input.repo,
      intent: input.item.brief,
      outFile: input.taskFile,
    });
    if (!planned.valid) throw new Error(`could not reconstruct interrupted plan: ${planned.issues.join("; ")}`);
  }
}

async function ensureActiveBranch(repo: string, branch: string, base: string): Promise<void> {
  const existing = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.code === 0) {
    await checkoutExistingBranch(repo, branch);
    return;
  }
  const created = await git(repo, ["checkout", "-b", branch, base]);
  if (created.code !== 0) throw new Error(created.log || `failed to create interrupted item branch ${branch}`);
}
