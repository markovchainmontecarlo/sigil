import { readFile } from "node:fs/promises";

import { z } from "zod";

import { runFreshAgentOperation } from "../../../agent-operation.js";
import type { SigilConfig } from "../../../config.js";
import type { SigilContext } from "../../../context.js";
import type { WorkflowFailure } from "../../../recovery/index.js";
import { planningPrompts } from "./prompts.js";
import {
  readTaskGraph,
  repairTaskGraphJson,
  type TaskGraphCheck,
} from "./task-graph.js";

export const PlanningReviewCategorySchema = z.enum([
  "missing-requirement",
  "placeholder",
  "task-too-broad",
  "task-too-small",
  "missing-dependency",
  "interface-conflict",
  "undefined-symbol",
  "incorrect-file",
  "unverifiable-criterion",
  "missing-test-coverage",
  "unnecessary-scope",
  "stale-anchor",
]);

export const PlanningReviewFindingSchema = z.object({
  category: PlanningReviewCategorySchema,
  taskIds: z.array(z.string().min(1)),
  evidence: z.string().min(1),
  rule: z.string().min(1),
  correction: z.string().min(1),
}).strict();

export const PlanningReviewOutputSchema = z.object({
  valid: z.boolean(),
  findings: z.array(PlanningReviewFindingSchema),
}).strict().superRefine((value, context) => {
  if (value.valid === (value.findings.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "valid must be true exactly when findings is empty",
    });
  }
});

export type PlanningReviewFinding = z.infer<typeof PlanningReviewFindingSchema>;
export type PlanningReviewOutput = z.infer<typeof PlanningReviewOutputSchema>;

export type PlanningConvergenceResult = {
  checked: TaskGraphCheck;
  findings: PlanningReviewFinding[];
  failures: WorkflowFailure[];
  issues: string[];
};

type PlanningConvergenceInput = {
  repo: string;
  intent: string;
  brief: string;
  taskFile: string;
  crosswalk: string;
  contract: string;
  rubric: string;
  config: SigilConfig;
};

async function collectPlanningReview(
  ctx: SigilContext,
  input: PlanningConvergenceInput,
  attempt: number,
): Promise<{ review?: PlanningReviewOutput; failures: WorkflowFailure[]; issue?: string }> {
  await ctx.observe("planning-review-started", { attempt: String(attempt + 1) });
  const taskGraph = await readFile(input.taskFile, "utf8");

  const reviewed = await runFreshAgentOperation(
    ctx,
    input.config.plan.reviewer,
    {
      stage: "planning:semantic-review",
      limit: input.config.implement.repairLimit,
      timeoutMs: input.config.implement.operationTimeoutMs,
      idleTimeoutMs: input.config.implement.idleTimeoutMs,
    },
    (reviewer) => reviewer.prompt(
      planningPrompts.reviewTaskGraph({
        RUBRIC: input.rubric,
        INTENT: input.intent,
        BRIEF: input.brief,
        CROSSWALK: input.crosswalk,
        TASK_GRAPH: taskGraph,
      }),
      PlanningReviewOutputSchema,
    ),
  );

  if (!reviewed.ok) {
    return { failures: reviewed.failures, issue: reviewed.failure.evidence };
  }

  await ctx.artifacts.write(
    `planning/review-${String(attempt + 1)}.json`,
    `${JSON.stringify(reviewed.value, null, 2)}\n`,
  );
  await ctx.observe("planning-review-completed", {
    attempt: String(attempt + 1),
    outcome: reviewed.value.valid ? "valid" : "findings",
    findingCount: String(reviewed.value.findings.length),
  });
  return { review: reviewed.value, failures: reviewed.failures };
}

async function repairPlanningFindings(
  ctx: SigilContext,
  input: PlanningConvergenceInput,
  findings: PlanningReviewFinding[],
  attempt: number,
): Promise<{ checked: TaskGraphCheck; failures: WorkflowFailure[]; issue?: string }> {
  await ctx.observe("planning-review-repair-started", { attempt: String(attempt + 1) });

  const repaired = await runFreshAgentOperation(
    ctx,
    input.config.plan.synthesizer,
    {
      stage: "planning:semantic-repair",
      limit: input.config.implement.repairLimit,
      timeoutMs: input.config.implement.operationTimeoutMs,
      idleTimeoutMs: input.config.implement.idleTimeoutMs,
    },
    async (synthesizer) => {
      const emitted = await ctx.emit(
        synthesizer,
        planningPrompts.repairTaskGraph({
          TASK_FILE: input.taskFile,
          CONTRACT: input.contract,
          FINDINGS: JSON.stringify(findings, null, 2),
        }),
        input.taskFile,
        { minBytes: 1, mustChange: true },
      );
      if (!emitted.ok) throw new Error(`planning repair failed: ${emitted.issue}`);

      return repairTaskGraphJson(ctx, synthesizer, {
        taskFile: input.taskFile,
        repo: input.repo,
        contract: input.contract,
        limit: input.config.implement.repairLimit,
        issuePrefix: "reviewed task graph",
      });
    },
  );

  if (!repaired.ok) {
    return {
      checked: await readTaskGraph(input.taskFile, input.repo),
      failures: repaired.failures,
      issue: repaired.failure.evidence,
    };
  }

  await ctx.observe("planning-review-repair-completed", {
    attempt: String(attempt + 1),
    outcome: repaired.value.errors.length ? "invalid" : "valid",
  });
  return { checked: repaired.value, failures: repaired.failures };
}

export async function convergePlanningReview(
  ctx: SigilContext,
  input: PlanningConvergenceInput,
): Promise<PlanningConvergenceResult> {
  const failures: WorkflowFailure[] = [];
  let checked = await readTaskGraph(input.taskFile, input.repo);
  let findings: PlanningReviewFinding[] = [];

  for (let attempt = 0; attempt <= input.config.plan.semanticReviewLimit; attempt++) {
    const reviewed = await collectPlanningReview(ctx, input, attempt);
    failures.push(...reviewed.failures);
    if (!reviewed.review) {
      return { checked, findings, failures, issues: [reviewed.issue ?? "planning review failed"] };
    }

    findings = reviewed.review.findings;
    if (reviewed.review.valid) return { checked, findings: [], failures, issues: [] };
    if (attempt === input.config.plan.semanticReviewLimit) break;

    const repaired = await repairPlanningFindings(ctx, input, findings, attempt);
    failures.push(...repaired.failures);
    checked = repaired.checked;
    if (repaired.issue) return { checked, findings, failures, issues: [repaired.issue] };
    if (checked.errors.length) return { checked, findings, failures, issues: checked.errors };
  }

  await ctx.observe("planning-review-exhausted", {
    findingCount: String(findings.length),
  });
  return {
    checked,
    findings,
    failures,
    issues: findings.map((finding) => `${finding.category}: ${finding.correction}`),
  };
}
