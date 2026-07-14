import { z } from "zod";

import { runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig } from "../../../config.js";
import { sigil, type SigilContext } from "../../../context.js";
import { git } from "../../../git.js";
import { runGateSet, type VerificationResult } from "../../../verification.js";
import { reviewPrompts } from "./prompts.js";
import { runReviewOperation } from "./state.js";

export type ReviewInput = { repo: string; base: string; autofix?: boolean; context?: string };

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  failureScenario: z.string().min(1),
  defect: z.string().min(1),
  requiredChange: z.string().min(1),
  repairRecommended: z.boolean(),
  source: z.enum(["correctness", "test-integrity"]).default("correctness"),
});

const ReviewOutputSchema = z.object({
  findings: z.array(ReviewFindingSchema),
});

const TestIntegrityOutputSchema = z.object({
  weakened: z.boolean(),
  findings: z.array(ReviewFindingSchema.omit({ source: true }).extend({
    source: z.literal("test-integrity").default("test-integrity"),
  })),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewResult = {
  valid: boolean;
  findings: string;
  structuredFindings?: ReviewFinding[];
  findingsFile: string;
  unresolvedHigh: number;
  fixRan: boolean;
  verification?: VerificationResult;
  issues: string[];
};

type ReviewScope = { ok: true; paths: string[]; stat: string } | { ok: false; issue: string };

function findingKey(finding: ReviewFinding): string {
  return finding.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function actionable(finding: ReviewFinding): boolean {
  return finding.severity === "high"
    || finding.source === "test-integrity"
    || (finding.severity === "medium" && finding.repairRecommended);
}

function renderFindings(findings: ReviewFinding[]): string {
  if (!findings.length) return "No findings.\n";
  return findings.map((finding) => [
    `## ${finding.severity.toUpperCase()} ${finding.id}`,
    "",
    `**${finding.path}${finding.line ? `:${String(finding.line)}` : ""}**`,
    "",
    `Failure scenario: ${finding.failureScenario}`,
    "",
    `Defect: ${finding.defect}`,
    "",
    `Required change: ${finding.requiredChange}`,
    "",
    `Repair recommended: ${finding.repairRecommended ? "yes" : "no"}`,
    "",
    `Source: ${finding.source}`,
  ].join("\n")).join("\n\n");
}

async function writeDispositions(
  ctx: SigilContext,
  findings: ReviewFinding[],
  unresolved: Set<string>,
): Promise<void> {
  await ctx.artifacts.write(
    "review/dispositions.json",
    `${JSON.stringify({
      findings: findings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        disposition: actionable(finding)
          ? (unresolved.has(findingKey(finding)) ? "unresolved" : "resolved")
          : "not-actionable",
      })),
    }, null, 2)}\n`,
  );
}

async function readReviewScope(repo: string, base: string): Promise<ReviewScope> {
  const paths = await git(repo, ["diff", "--name-only", base, "--"]);
  if (paths.code !== 0) return { ok: false, issue: paths.log || `git diff --name-only ${base} failed` };

  const stat = await git(repo, ["diff", "--stat", base, "--"]);
  if (stat.code !== 0) return { ok: false, issue: stat.log || `git diff --stat ${base} failed` };

  return { ok: true, paths: paths.stdout.split("\n").filter(Boolean), stat: stat.stdout };
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|test|tests)(\/|$)/.test(path)
    || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
}

async function collectCorrectnessFindings(
  ctx: SigilContext,
  input: ReviewInput,
  scope: Extract<ReviewScope, { ok: true }>,
  reviewer: string,
  limit: number,
  timeoutMs: number,
): Promise<ReviewFinding[]> {
  const operationInput = {
    context: input.context ?? "",
    base: input.base,
    changedPaths: scope.paths,
    diffStat: scope.stat,
  };
  const operationName = `correctness-${reviewer.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  const reviewed = await runReviewOperation(
    ctx,
    "review/panel",
    operationName,
    operationInput,
    () => runFreshAgentOperation(
      ctx,
      reviewer,
      { stage: "software-change:review", limit, timeoutMs },
      (agent) => agent.prompt(reviewPrompts.findings({
        CONTEXT: operationInput.context,
        BASE: operationInput.base,
        CHANGED_PATHS: operationInput.changedPaths.join("\n"),
        DIFF_STAT: operationInput.diffStat,
      }), ReviewOutputSchema),
    ),
  );
  if (!reviewed.ok) throw new Error(reviewed.failure.evidence);
  return reviewed.value.findings.map((finding) => ({ ...finding, source: "correctness" }));
}

async function collectTestIntegrityFindings(
  ctx: SigilContext,
  input: ReviewInput,
  scope: Extract<ReviewScope, { ok: true }>,
  reviewer: string,
  limit: number,
  timeoutMs: number,
): Promise<ReviewFinding[]> {
  const testPaths = scope.paths.filter(isTestPath);
  if (!testPaths.length) return [];

  const testDiff = await git(input.repo, ["diff", input.base, "--", ...testPaths]);
  if (testDiff.code !== 0) throw new Error(testDiff.log || "test integrity diff failed");

  const reviewed = await runReviewOperation(
    ctx,
    "review/test-integrity",
    "test-integrity",
    { paths: testPaths, diff: testDiff.stdout },
    () => runFreshAgentOperation(
      ctx,
      reviewer,
      { stage: "software-change:test-integrity", limit, timeoutMs },
      (agent) => agent.prompt(reviewPrompts.testIntegrity({ DIFF: testDiff.stdout }), TestIntegrityOutputSchema),
    ),
  );
  if (!reviewed.ok) throw new Error(reviewed.failure.evidence);
  return reviewed.value.weakened ? reviewed.value.findings : [];
}

async function synthesizeCorrectnessFindings(
  ctx: SigilContext,
  reports: Array<{ reviewer: string; findings: ReviewFinding[] }>,
  synthesizer: string,
  limit: number,
  timeoutMs: number,
): Promise<ReviewFinding[]> {
  if (reports.length === 1) return reports[0]?.findings ?? [];

  const synthesized = await runFreshAgentOperation(
    ctx,
    synthesizer,
    { stage: "software-change:review-synthesis", limit, timeoutMs },
    (agent) => agent.prompt(reviewPrompts.synthesizeFindings({
      REPORTS: JSON.stringify(reports, null, 2),
    }), ReviewOutputSchema),
  );
  if (!synthesized.ok) throw new Error(synthesized.failure.evidence);
  return synthesized.value.findings.map((finding) => ({ ...finding, source: "correctness" }));
}

async function collectFindings(
  ctx: SigilContext,
  input: ReviewInput,
  reviewers: string[],
  synthesizer: string,
  limit: number,
  timeoutMs: number,
): Promise<{ scope: ReviewScope; findings: ReviewFinding[] }> {
  const scope = await readReviewScope(input.repo, input.base);
  if (!scope.ok || !scope.paths.length) return { scope, findings: [] };

  const reports = await Promise.all(reviewers.map(async (reviewer) => {
    const findings = await collectCorrectnessFindings(ctx, input, scope, reviewer, limit, timeoutMs);
    await ctx.artifacts.write(
      `review-${reviewer.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`,
      `${JSON.stringify({ reviewer, findings }, null, 2)}\n`,
    );
    return { reviewer, findings };
  }));
  const correctness = await synthesizeCorrectnessFindings(
    ctx,
    reports,
    synthesizer,
    limit,
    timeoutMs,
  );
  const integrity = await collectTestIntegrityFindings(ctx, input, scope, synthesizer, limit, timeoutMs);
  const findings = [...correctness, ...integrity];
  await runReviewOperation(
    ctx,
    "review/synthesis",
    "synthesis",
    { correctness, integrity },
    async () => ({ findings }),
  );
  return { scope, findings };
}

async function repairFindings(
  ctx: SigilContext,
  findings: ReviewFinding[],
  context: string | undefined,
  coder: string,
  limit: number,
  timeoutMs: number,
): Promise<void> {
  const repaired = await runReviewOperation(
    ctx,
    "review/repair",
    "repair",
    { context: context ?? "", findings },
    () => runFreshAgentOperation(
      ctx,
      coder,
      { stage: "software-change:review-repair", limit, timeoutMs },
      (agent) => agent.prompt(reviewPrompts.fix({
        CONTEXT: context ?? "",
        FINDINGS: JSON.stringify(findings, null, 2),
      })),
    ),
  );
  if (!repaired.ok) throw new Error(repaired.failure.evidence);
}

async function verifyRepair(ctx: SigilContext): Promise<VerificationResult> {
  return runReviewOperation(
    ctx,
    "post-review-verification",
    "post-review-verification",
    { gates: ["build", "test", "e2e", "verify"] },
    () => runGateSet(ctx, ["build", "test", "e2e", "verify"]),
  );
}

function exhaustedIssues(findings: ReviewFinding[], attempts: Map<string, number>, limit: number): string[] {
  return findings
    .filter((finding) => actionable(finding) && (attempts.get(findingKey(finding)) ?? 0) >= limit)
    .map((finding) => `review finding ${finding.id} exhausted repair: ${finding.requiredChange}`);
}

export const review = sigil<ReviewInput, ReviewResult>("review", async (ctx, input) => {
  const config = loadConfig(input.repo);
  const findingsFile = ctx.artifacts.path("review-findings.md");
  const attempts = new Map<string, number>();
  const encountered = new Map<string, ReviewFinding>();
  let followUpReviewsRemaining = config.review.followUpReviews;
  let fixRan = false;
  let verification: VerificationResult | undefined;

  try {
    let reviewed = await collectFindings(
      ctx,
      input,
      config.review.reviewers,
      config.review.synthesizer,
      config.implement.repairLimit,
      config.implement.operationTimeoutMs,
    );
    for (const finding of reviewed.findings) encountered.set(findingKey(finding), finding);
    if (!reviewed.scope.ok) {
      return { valid: false, findings: "", structuredFindings: [], findingsFile, unresolvedHigh: 0, fixRan, issues: [reviewed.scope.issue] };
    }

    while (input.autofix && reviewed.findings.some(actionable)) {
      const exhausted = exhaustedIssues(reviewed.findings, attempts, config.implement.repairLimit);
      if (exhausted.length) {
        const rendered = renderFindings(reviewed.findings);
        await ctx.artifacts.write("review-findings.md", rendered);
        await writeDispositions(
          ctx,
          [...encountered.values()],
          new Set(reviewed.findings.filter(actionable).map(findingKey)),
        );
        return {
          valid: false,
          findings: rendered,
          structuredFindings: reviewed.findings,
          findingsFile,
          unresolvedHigh: reviewed.findings.filter((finding) => finding.severity === "high").length,
          fixRan,
          issues: exhausted,
        };
      }

      const current = reviewed.findings.filter(actionable);
      for (const finding of current) {
        const key = findingKey(finding);
        attempts.set(key, (attempts.get(key) ?? 0) + 1);
      }
      await repairFindings(
        ctx,
        current,
        input.context,
        config.implement.coder,
        config.implement.repairLimit,
        config.implement.operationTimeoutMs,
      );
      fixRan = true;

      verification = await verifyRepair(ctx);
      const configured = verification.gates.filter((gate) => !gate.result.skipped);
      if (configured.length && !verification.ok) {
        const gateFinding: ReviewFinding = {
          id: "post-review-gates",
          severity: "high",
          path: ".",
          failureScenario: verification.evidence,
          defect: "Review repair failed configured verification.",
          requiredChange: "Repair the reported gate failures without weakening verification.",
          repairRecommended: true,
          source: "correctness",
        };
        reviewed = { ...reviewed, findings: [gateFinding] };
        continue;
      }

      if (followUpReviewsRemaining === 0) {
        reviewed = {
          ...reviewed,
          findings: reviewed.findings.filter((finding) => !actionable(finding)),
        };
        break;
      }

      followUpReviewsRemaining -= 1;
      reviewed = await collectFindings(
        ctx,
        input,
        config.review.reviewers,
        config.review.synthesizer,
        config.implement.repairLimit,
        config.implement.operationTimeoutMs,
      );
      for (const finding of reviewed.findings) encountered.set(findingKey(finding), finding);
    }

    const rendered = renderFindings(reviewed.findings);
    await ctx.artifacts.write("review-findings.md", rendered);
    const unresolved = reviewed.findings.filter(actionable);
    await writeDispositions(
      ctx,
      [...encountered.values()],
      new Set(unresolved.map(findingKey)),
    );
    return {
      valid: unresolved.length === 0,
      findings: rendered,
      structuredFindings: reviewed.findings,
      findingsFile,
      unresolvedHigh: reviewed.findings.filter((finding) => finding.severity === "high").length,
      fixRan,
      verification,
      issues: unresolved.map((finding) => `unresolved review finding ${finding.id}: ${finding.requiredChange}`),
    };
  } catch (error) {
    return {
      valid: false,
      findings: "",
      structuredFindings: [],
      findingsFile,
      unresolvedHigh: 0,
      fixRan,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
});
