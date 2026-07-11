import { runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig } from "../../../config.js";
import { git } from "../../../git.js";
import { sigil, type SigilContext } from "../../../context.js";
import { reviewPrompts } from "./prompts.js";

export type ReviewInput = { repo: string; base: string; autofix?: boolean; context?: string };
export type ReviewResult = { valid: boolean; findings: string; findingsFile: string; unresolvedHigh: number; fixRan: boolean; issues: string[] };

const HIGH_LINE = /^\s*HIGH\b/gm;
const ACTIONABLE_LINE = /^\s*(HIGH|MEDIUM)\b/m;

export function parseUnresolvedHigh(text: string): number | undefined {
  const match = text.match(/^\s*UNRESOLVED-HIGH\s*:\s*(\d+)\s*$/m);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function parseWeakenedVerdict(text: string): boolean | undefined {
  const finalLine = text.trim().split(/\r?\n/).at(-1) ?? "";
  const match = finalLine.match(/^\s*WEAKENED\s*:\s*(yes|no)\s*$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() === "yes";
}

function countHigh(text: string): number {
  return [...text.matchAll(HIGH_LINE)].length;
}

function hasActionableFinding(text: string): boolean {
  return ACTIONABLE_LINE.test(text);
}

export const review = sigil<ReviewInput, ReviewResult>("review", async (ctx, input) => {
  const findingsFile = ctx.artifacts.path("review-findings.md");
  const scope = await readReviewScope(input.repo, input.base);

  if (!scope.ok) {
    return { valid: false, findings: "", findingsFile, unresolvedHigh: 0, fixRan: false, issues: [scope.issue] };
  }
  if (!scope.paths.length) return { valid: true, findings: "", findingsFile, unresolvedHigh: 0, fixRan: false, issues: [] };

  const config = loadConfig(input.repo);
  const reviewed = await runFreshAgentOperation(
    ctx,
    config.review.reviewer,
    {
      stage: "software-change:review",
      limit: config.implement.repairLimit,
      timeoutMs: config.implement.operationTimeoutMs,
    },
    async (reviewer) => {
      const findings = await reviewer.prompt(
        reviewPrompts.findings({
          CONTEXT: input.context ?? "",
          BASE: input.base,
          CHANGED_PATHS: scope.paths.join("\n"),
          DIFF_STAT: scope.stat,
          OUT_FILE: findingsFile,
        }),
        { writes: "review-findings.md", minBytes: 1 },
      );
      if (!findings) throw new Error("review produced no findings artifact");

      let unresolvedHigh = countHigh(findings);
      let fixRan = false;
      if (input.autofix && hasActionableFinding(findings)) {
        const fixReply = await reviewer.prompt(reviewPrompts.fix({ FINDINGS: findings }));
        fixRan = true;
        const parsed = parseUnresolvedHigh(fixReply);
        if (parsed === undefined) throw new Error("review fix did not end with UNRESOLVED-HIGH: <count>");
        unresolvedHigh = parsed;
      }
      return { findings, unresolvedHigh, fixRan };
    },
  );
  if (!reviewed.ok) {
    return {
      valid: false,
      findings: "",
      findingsFile,
      unresolvedHigh: 0,
      fixRan: false,
      issues: [reviewed.failure.evidence],
    };
  }

  const updatedScope = await readReviewScope(input.repo, input.base);
  if (!updatedScope.ok) {
    return {
      valid: false,
      findings: reviewed.value.findings,
      findingsFile,
      unresolvedHigh: reviewed.value.unresolvedHigh,
      fixRan: reviewed.value.fixRan,
      issues: [updatedScope.issue],
    };
  }
  const integrity = await reviewTestIntegrity(ctx, input.repo, input.base, updatedScope.paths, config.review.reviewer, config.implement.repairLimit, config.implement.operationTimeoutMs);
  const unresolvedHigh = integrity.weakened
    ? Math.max(reviewed.value.unresolvedHigh, 1)
    : reviewed.value.unresolvedHigh;
  return {
    valid: integrity.valid,
    findings: reviewed.value.findings,
    findingsFile,
    unresolvedHigh,
    fixRan: reviewed.value.fixRan,
    issues: integrity.issues,
  };
});

type ReviewScope = { ok: true; paths: string[]; stat: string } | { ok: false; issue: string };

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

async function reviewTestIntegrity(
  ctx: SigilContext,
  repo: string,
  base: string,
  changed: string[],
  reviewer: string,
  limit: number,
  timeoutMs: number,
): Promise<{ valid: boolean; weakened: boolean; issues: string[] }> {
  const testPaths = changed.filter(isTestPath);
  if (!testPaths.length) return { valid: true, weakened: false, issues: [] };
  const testDiff = await git(repo, ["diff", base, "--", ...testPaths]);
  if (testDiff.code !== 0) return { valid: false, weakened: false, issues: [testDiff.log || "test integrity diff failed"] };
  const checked = await runFreshAgentOperation(
    ctx,
    reviewer,
    { stage: "software-change:test-integrity", limit, timeoutMs },
    async (agent) => parseWeakenedVerdict(await agent.prompt(reviewPrompts.testIntegrity({ DIFF: testDiff.stdout }))),
  );
  if (!checked.ok) return { valid: false, weakened: false, issues: [checked.failure.evidence] };
  if (checked.value === undefined) return { valid: false, weakened: false, issues: ["test integrity review did not end with WEAKENED: yes|no"] };
  if (!checked.value) return { valid: true, weakened: false, issues: [] };
  return { valid: true, weakened: true, issues: [`weakened-tests: changed tests were judged to weaken tests: ${testPaths.join(", ")}`] };
}
