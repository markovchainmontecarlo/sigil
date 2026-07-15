import { readFile } from "node:fs/promises";

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

export type PlanningReviewSeverity = "high" | "medium" | "low";

export type PlanningReviewSummary = Record<PlanningReviewSeverity, number>;

export type PlanningConvergenceResult = {
  checked: TaskGraphCheck;
  reportFile: string;
  summary: PlanningReviewSummary;
  failures: WorkflowFailure[];
  issues: string[];
};

type PlanningReviewInput = {
  repo: string;
  intent: string;
  brief: string;
  taskFile: string;
  crosswalk: string;
  contract: string;
  rubric: string;
  config: SigilConfig;
};

const REVIEW_SECTIONS: Array<{
  severity: PlanningReviewSeverity;
  heading: string;
}> = [
  { severity: "high", heading: "HIGH" },
  { severity: "medium", heading: "MEDIUM" },
  { severity: "low", heading: "LOW" },
];

function sectionBody(report: string, heading: string): string {
  const section = new RegExp(
    `^## ${heading}\\s*$([\\s\\S]*?)(?=^## (?:HIGH|MEDIUM|LOW)\\s*$|(?![\\s\\S]))`,
    "m",
  ).exec(report);
  if (!section) throw new Error(`planning review report is missing ## ${heading}`);
  return section[1]?.trim() ?? "";
}

export function summarizePlanningReview(report: string): PlanningReviewSummary {
  return Object.fromEntries(REVIEW_SECTIONS.map(({ severity, heading }) => {
    const body = sectionBody(report, heading);
    const count = [...body.matchAll(/^###\s+\S.*$/gm)].length;
    if (count === 0 && body !== "None.") {
      throw new Error(`planning review ## ${heading} must contain findings or exactly \"None.\"`);
    }
    return [severity, count];
  })) as PlanningReviewSummary;
}

export async function reviewPlanningGraph(
  ctx: SigilContext,
  input: PlanningReviewInput,
): Promise<PlanningConvergenceResult> {
  const reportFile = ctx.artifacts.path("planning/review.md");
  const reviewed = await runFreshAgentOperation(
    ctx,
    input.config.plan.reviewer,
    {
      stage: "planning:review",
      limit: input.config.implement.repairLimit,
      timeoutMs: input.config.implement.operationTimeoutMs,
      idleTimeoutMs: input.config.implement.idleTimeoutMs,
    },
    async (reviewer) => {
      const taskGraph = await readFile(input.taskFile, "utf8");
      const emitted = await ctx.emit(
        reviewer,
        planningPrompts.reviewTaskGraph({
          RUBRIC: input.rubric,
          INTENT: input.intent,
          BRIEF: input.brief,
          CROSSWALK: input.crosswalk,
          TASK_GRAPH: taskGraph,
          OUT_FILE: reportFile,
        }),
        reportFile,
        { minBytes: 1 },
      );
      if (!emitted.ok) throw new Error(`planning review failed: ${emitted.issue}`);

      const report = emitted.contents[0] ?? "";
      const summary = summarizePlanningReview(report);
      await ctx.observe("planning-review-completed", {
        high: String(summary.high),
        medium: String(summary.medium),
        low: String(summary.low),
      });

      if (summary.high === 0) {
        return {
          checked: await readTaskGraph(input.taskFile, input.repo),
          summary,
        };
      }

      const repaired = await ctx.emit(
        reviewer,
        planningPrompts.repairTaskGraph({
          TASK_FILE: input.taskFile,
          CONTRACT: input.contract,
          FINDINGS: report,
        }),
        input.taskFile,
        { minBytes: 1, mustChange: true },
      );
      if (!repaired.ok) throw new Error(`planning repair failed: ${repaired.issue}`);

      const checked = await repairTaskGraphJson(ctx, reviewer, {
        taskFile: input.taskFile,
        repo: input.repo,
        contract: input.contract,
        limit: input.config.implement.repairLimit,
        issuePrefix: "reviewed task graph",
      });
      await ctx.observe("planning-review-repair-completed", {
        outcome: checked.errors.length ? "invalid" : "valid",
      });
      return { checked, summary };
    },
  );

  if (!reviewed.ok) {
    return {
      checked: await readTaskGraph(input.taskFile, input.repo),
      reportFile,
      summary: { high: 0, medium: 0, low: 0 },
      failures: reviewed.failures,
      issues: [reviewed.failure.evidence],
    };
  }

  return {
    checked: reviewed.value.checked,
    reportFile,
    summary: reviewed.value.summary,
    failures: reviewed.failures,
    issues: [],
  };
}
