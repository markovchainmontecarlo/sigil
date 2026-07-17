import { appendFile, readFile } from "node:fs/promises";

import { z } from "zod";
import { bootstrapWorkspace } from "../../workspace.js";

import {
  promptAgentTurn,
  runFreshAgentOperation,
} from "../../agent-operation.js";
import { loadConfig } from "../../config.js";
import { loadConfiguredContext, renderContextBlock, sigil, type RichSigilAgent, type SigilContext } from "../../context.js";
import { changedPaths, git, isCleanTree } from "../../git.js";
import { requireImplementationVerification } from "../../repository-setup.js";
import {
  recover,
  retryOperation,
  type OperationAttemptControls,
  type RecoveryResult,
  type WorkflowFailure,
} from "../../recovery/index.js";
import {
  compareWithBaseline,
  establishBaseline,
  runBuildAndTest,
  verifyWithRepair,
  type Baseline,
} from "../../verification.js";
import { refactorPrompt } from "./prompts.js";

export type RefactorInput = {
  repo: string;
  intent: string;
  brief?: string;
  focus?: string[];
  protectedPaths?: string[];
};

export type PathDiscovery = { path: string; justification: string };

export type RefactorResult = {
  branch: string;
  planFile: string;
  structureReviewFile: string;
  behaviorReviewFile: string;
  eventsFile: string;
  changedFiles: string[];
  valid: boolean;
  issues: string[];
  failures: WorkflowFailure[];
  discoveries: PathDiscovery[];
};

const RefactorPlanSchema = z.object({
  goal: z.string().min(1),
  invariants: z.array(z.string().min(1)).min(1),
  slices: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
    expectedChange: z.string().min(1),
  })).min(1).max(6),
});

const ReviewSchema = z.object({
  blocking: z.boolean(),
  findings: z.array(z.object({
    id: z.string().min(1).optional(),
    severity: z.enum(["high", "medium", "low"]),
    evidence: z.string().min(1),
    requiredChange: z.string().min(1),
  })),
});

type RefactorPlan = z.infer<typeof RefactorPlanSchema>;
type RefactorReview = z.infer<typeof ReviewSchema>;

export const refactor = sigil<RefactorInput, RefactorResult>("refactor", async (ctx, input) => {
  const failures: WorkflowFailure[] = [];
  const eventsFile = await ctx.artifacts.write("refactor-events.jsonl", "");
  await recordStage(eventsFile, "starting");
  const config = requireImplementationVerification(input.repo);
  await requireCleanTree(input.repo);
  const branch = await currentBranch(input.repo);
  await bootstrapWorkspace(ctx, input.repo, config);
  const context = renderContextBlock(await loadConfiguredContext(input.repo, config.context));
  await recordStage(eventsFile, "baseline-gates");
  const baseline = await establishBaselineWithRecovery(
    ctx,
    input,
    config.implement.coder,
    config.implement.repairLimit,
    config.implement.operationTimeoutMs,
    eventsFile,
    failures,
  );
  if (!baseline) {
    await recordStage(eventsFile, "failed", { stage: "baseline" });
    return failedResult(ctx, branch, eventsFile, failures);
  }

  await recordStage(eventsFile, "analyzing");
  const analyses = await analyzeRefactor(
    ctx,
    config.plan.planners,
    input,
    context,
    config.implement.repairLimit,
    config.implement.operationTimeoutMs,
    failures,
  );
  if (!analyses) {
    await recordStage(eventsFile, "failed", { stage: "analysis" });
    return failedResult(ctx, branch, eventsFile, failures);
  }
  const [structureAnalysis, riskAnalysis] = analyses;
  const plan = await synthesizePlanWithRecovery(
    ctx,
    config.plan.synthesizer,
    config.implement.repairLimit,
    config.implement.operationTimeoutMs,
    input,
    structureAnalysis,
    riskAnalysis,
    eventsFile,
    failures,
  );
  if (!plan) {
    await recordStage(eventsFile, "failed", { stage: "plan-synthesis" });
    return failedResult(ctx, branch, eventsFile, failures);
  }
  const planFile = await ctx.artifacts.write(
    "refactor-plan.json",
    `${JSON.stringify(plan, null, 2)}\n`,
  );

  await recordStage(eventsFile, "implementing");
  const slicesValid = await implementSlices(
    ctx,
    config.implement.coder,
    config.implement.repairLimit,
    config.implement.operationTimeoutMs,
    input,
    plan,
    eventsFile,
    failures,
  );
  if (!slicesValid) {
    await recordStage(eventsFile, "failed", { stage: "slices" });
    return failedResult(ctx, branch, eventsFile, failures, planFile, plan, input.repo);
  }

  const convergence = await convergeRefactor(
    ctx,
    config.implement.coder,
    config.review.synthesizer,
    config.implement.repairLimit,
    config.implement.operationTimeoutMs,
    input,
    plan,
    baseline,
    eventsFile,
    failures,
  );
  const structureReviewFile = convergence.structure
    ? await writeReview(ctx, "refactor-structure-review.json", convergence.structure)
    : await ctx.artifacts.write("refactor-structure-review.json", "{}\n");
  const behaviorReviewFile = convergence.behavior
    ? await writeReview(ctx, "refactor-behavior-review.json", convergence.behavior)
    : await ctx.artifacts.write("refactor-behavior-review.json", "{}\n");

  const changedFiles = await reviewPaths(input.repo);
  const discoveries = discoverPaths(input, plan, changedFiles);
  const valid = convergence.ok && !failures.some((failure) => !failure.recoverable);
  await recordStage(eventsFile, valid ? "completed" : "failed");
  return {
    branch,
    planFile,
    structureReviewFile,
    behaviorReviewFile,
    eventsFile,
    changedFiles,
    valid,
    issues: failures.filter((failure) => !failure.recoverable).map((failure) => failure.evidence),
    failures,
    discoveries,
  };
});

async function analyzeRefactor(
  ctx: SigilContext,
  planners: string[],
  input: RefactorInput,
  context: string,
  repairLimit: number,
  timeoutMs: number,
  failures: WorkflowFailure[],
): Promise<[string, string] | undefined> {
  const structureAgent = planners[0];
  const riskAgent = planners[1] ?? planners[0];
  const common = promptVariables(input, context);
  const [structure, risk] = await Promise.all([
    runFreshAgentOperation(
      ctx,
      structureAgent,
      { stage: "analysis:structure", limit: repairLimit, timeoutMs },
      (agent) => agent.prompt(refactorPrompt("analyze-structure", common)),
    ),
    runFreshAgentOperation(
      ctx,
      riskAgent,
      { stage: "analysis:risk", limit: repairLimit, timeoutMs },
      (agent) => agent.prompt(refactorPrompt("analyze-risk", common)),
    ),
  ]);
  const structureValue = operationValue(structure, failures);
  const riskValue = operationValue(risk, failures);
  if (structureValue === undefined || riskValue === undefined) return undefined;
  return [structureValue, riskValue];
}

async function synthesizePlan(
  ctx: SigilContext,
  synthesizer: string,
  input: RefactorInput,
  structureAnalysis: string,
  riskAnalysis: string,
  controls: OperationAttemptControls,
): Promise<RefactorPlan> {
  return ctx.withAgent(synthesizer, (agent) => {
    if (!agent.promptWithOptions) throw new Error("agent does not support cancellable prompts");
    return agent.promptWithOptions(
      refactorPrompt("synthesize-plan", {
        INTENT: input.intent,
        BRIEF: input.brief ?? "",
        STRUCTURE_ANALYSIS: structureAnalysis,
        RISK_ANALYSIS: riskAnalysis,
      }),
      RefactorPlanSchema,
      {
        signal: controls.signal,
        onProgress: controls.progress,
      },
    ) as Promise<RefactorPlan>;
  });
}

async function synthesizePlanWithRecovery(
  ctx: SigilContext,
  synthesizer: string,
  repairLimit: number,
  timeoutMs: number,
  input: RefactorInput,
  structureAnalysis: string,
  riskAnalysis: string,
  eventsFile: string,
  failures: WorkflowFailure[],
): Promise<RefactorPlan | undefined> {
  const result = await retryOperation({
    limit: repairLimit,
    timeoutMs,
    operation: "plan-synthesis",
    run: (_attempt, controls) => synthesizePlan(
      ctx,
      synthesizer,
      input,
      structureAnalysis,
      riskAnalysis,
      controls,
    ),
    failure: (error, attempt, recoverable) => ({
      kind: "provider",
      stage: "plan-synthesis",
      evidence: error instanceof Error ? error.message : String(error),
      attempts: attempt,
      recoverable,
    }),
    record: async (failure) => recordStage(eventsFile, "plan-synthesis-retrying", {
      attempt: String(failure.attempts),
      recoverable: String(failure.recoverable),
    }),
  });
  failures.push(...result.failures);
  if (!result.ok) return undefined;
  return result.value;
}

async function implementSlices(
  ctx: SigilContext,
  coder: string,
  repairLimit: number,
  timeoutMs: number,
  input: RefactorInput,
  plan: RefactorPlan,
  eventsFile: string,
  failures: WorkflowFailure[],
): Promise<boolean> {
  let valid = true;
  await ctx.withAgent(coder, async (agent) => {
    for (const slice of plan.slices) {
      await recordStage(eventsFile, "slice-started", { slice: slice.id });
      const sliceText = JSON.stringify(slice, null, 2);
      const implementation = await promptAgentTurn(
        ctx,
        agent,
        refactorPrompt("implement-slice", {
          INTENT: input.intent,
          INVARIANTS: plan.invariants.join("\n"),
          SLICE: sliceText,
        }),
        { stage: `slice:${slice.id}:implement`, limit: repairLimit, timeoutMs },
      );
      if (operationValue(implementation, failures) === undefined) {
        valid = false;
        await recordStage(eventsFile, "slice-failed", { slice: slice.id, kind: "provider" });
        break;
      }
      const authorityValid = await repairScope(
        ctx,
        agent,
        repairLimit,
        timeoutMs,
        input,
        `slice:${slice.id}`,
        eventsFile,
        failures,
      );
      if (!authorityValid) {
        valid = false;
        await recordStage(eventsFile, "slice-failed", { slice: slice.id, kind: "authority" });
        break;
      }
      await recordStage(eventsFile, "slice-verifying", { slice: slice.id });
      let repairOperationValid = true;
      let repairAuthorityValid = true;
      const verification = await verifyWithRepair({
        ctx,
        stage: `slice:${slice.id}`,
        limit: repairLimit,
        verify: () => runBuildAndTest(ctx),
        repair: async (failure) => {
          await recordStage(eventsFile, "slice-repairing", { slice: slice.id });
          const repair = await promptAgentTurn(
            ctx,
            agent,
            refactorPrompt("repair-slice", {
              SLICE: sliceText,
              GATE_OUTPUT: failure.evidence,
            }),
            { stage: `slice:${slice.id}:gate-repair`, limit: repairLimit, timeoutMs },
          );
          repairOperationValid = operationValue(repair, failures) !== undefined;
          if (!repairOperationValid) return;
          repairAuthorityValid = await repairScope(
            ctx,
            agent,
            repairLimit,
            timeoutMs,
            input,
            `slice-repair:${slice.id}`,
            eventsFile,
            failures,
          );
        },
      });
      failures.push(...verification.failures);
      if (!repairOperationValid || !repairAuthorityValid || !verification.ok) {
        if (!verification.ok) failures.push({ ...verification.failure, recoverable: false });
        valid = false;
        const kind = repairAuthorityValid ? "gate" : "authority";
        await recordStage(eventsFile, "slice-failed", { slice: slice.id, kind });
        break;
      }
      await recordStage(eventsFile, "slice-completed", { slice: slice.id });
    }
  });
  return valid;
}

async function reviewRefactor(
  ctx: SigilContext,
  reviewer: string,
  input: RefactorInput,
  plan: RefactorPlan,
  diff: string,
  repairLimit: number,
  timeoutMs: number,
  failures: WorkflowFailure[],
  knownFindings: Map<string, number>,
): Promise<[RefactorReview, RefactorReview] | undefined> {
  const discoveries = discoverPaths(input, plan, await reviewPaths(input.repo));
  const common = {
    KNOWN_FINDINGS: JSON.stringify([...knownFindings.entries()], null, 2),
  };
  const [structure, behavior] = await Promise.all([
    runFreshAgentOperation(ctx, reviewer, {
      stage: "review:structure",
      limit: repairLimit,
      timeoutMs,
    }, (agent) => agent.prompt(
      refactorPrompt("review-structure", {
        ...common,
        INTENT: input.intent,
        PLAN: JSON.stringify(plan, null, 2),
        DISCOVERIES: JSON.stringify(discoveries, null, 2),
        DIFF: diff,
      }),
      ReviewSchema,
    )),
    runFreshAgentOperation(ctx, reviewer, {
      stage: "review:behavior",
      limit: repairLimit,
      timeoutMs,
    }, (agent) => agent.prompt(
      refactorPrompt("review-behavior", {
        ...common,
        INTENT: input.intent,
        INVARIANTS: plan.invariants.join("\n"),
        DISCOVERIES: JSON.stringify(discoveries, null, 2),
        DIFF: diff,
      }),
      ReviewSchema,
    )),
  ]);
  const structureValue = operationValue(structure, failures);
  const behaviorValue = operationValue(behavior, failures);
  if (structureValue === undefined || behaviorValue === undefined) return undefined;
  return [structureValue, behaviorValue];
}

type RefactorConvergence = {
  ok: boolean;
  structure?: RefactorReview;
  behavior?: RefactorReview;
};

async function convergeRefactor(
  ctx: SigilContext,
  coder: string,
  reviewer: string,
  repairLimit: number,
  timeoutMs: number,
  input: RefactorInput,
  plan: RefactorPlan,
  baseline: Baseline,
  eventsFile: string,
  failures: WorkflowFailure[],
): Promise<RefactorConvergence> {
  return ctx.withAgent(coder, async (agent) => {
    let last: RefactorConvergence = { ok: false };
    const findingAttempts = new Map<string, number>();
    let round = 0;
    while (true) {
      round++;
      await recordStage(eventsFile, "final-verifying", { round: String(round) });
      let authorityValid = true;
      const verification = await verifyWithRepair({
        ctx,
        stage: `final-verification:${round}`,
        limit: repairLimit,
        verify: () => compareWithBaseline(
          ctx,
          input.repo,
          loadConfig(input.repo),
          baseline,
        ),
        repair: async (failure) => {
          const repair = await promptAgentTurn(
            ctx,
            agent,
            refactorPrompt("repair-slice", {
              SLICE: JSON.stringify({
                id: "final-verification",
                description: input.intent,
              }, null, 2),
              GATE_OUTPUT: failure.evidence,
            }),
            { stage: "final-verification:repair", limit: repairLimit, timeoutMs },
          );
          if (operationValue(repair, failures) === undefined) {
            authorityValid = false;
            return;
          }
          authorityValid = await repairScope(
            ctx,
            agent,
            repairLimit,
            timeoutMs,
            input,
            "final-repair",
            eventsFile,
            failures,
          );
        },
      });
      failures.push(...verification.failures);
      if (!authorityValid) return last;
      if (!verification.ok) {
        failures.push({ ...verification.failure, recoverable: false });
        return last;
      }

      await recordStage(eventsFile, "reviewing", { round: String(round) });
      const reviews = await reviewRefactor(
        ctx,
        reviewer,
        input,
        plan,
        await readReviewDiff(input.repo),
        repairLimit,
        timeoutMs,
        failures,
        findingAttempts,
      );
      if (!reviews) return last;
      const [structure, behavior] = reviews;
      last = { ok: !structure.blocking && !behavior.blocking, structure, behavior };
      await writeReview(ctx, `refactor-reviews/round-${round}-structure.json`, structure);
      await writeReview(ctx, `refactor-reviews/round-${round}-behavior.json`, behavior);
      if (last.ok) return last;

      const findings = blockingFindings(structure, behavior);
      const exhausted = findings.filter((finding) =>
        (findingAttempts.get(reviewFindingKey(finding)) ?? 0) >= repairLimit,
      );
      if (exhausted.length) {
        failures.push({
          kind: "review",
          stage: "review",
          evidence: JSON.stringify({ exhausted, structure, behavior }),
          attempts: repairLimit,
          recoverable: false,
        });
        return last;
      }

      for (const finding of findings) {
        const key = reviewFindingKey(finding);
        findingAttempts.set(key, (findingAttempts.get(key) ?? 0) + 1);
      }
      failures.push({
        kind: "review",
        stage: "review",
        evidence: JSON.stringify({ structure, behavior }),
        attempts: Math.max(...findings.map((finding) =>
          findingAttempts.get(reviewFindingKey(finding)) ?? 0,
        )),
        recoverable: true,
      });
      await recordStage(eventsFile, "repairing-review", { round: String(round) });
      const repair = await promptAgentTurn(
        ctx,
        agent,
        refactorPrompt("repair-review", {
          STRUCTURE_REVIEW: JSON.stringify(structure, null, 2),
          BEHAVIOR_REVIEW: JSON.stringify(behavior, null, 2),
          REPAIR_HISTORY: JSON.stringify([...findingAttempts.entries()], null, 2),
        }),
        { stage: "review:repair", limit: repairLimit, timeoutMs },
      );
      if (operationValue(repair, failures) === undefined) return last;
      if (!await repairScope(
        ctx,
        agent,
        repairLimit,
        timeoutMs,
        input,
        "review-repair",
        eventsFile,
        failures,
      )) return last;
    }
  });
}

function blockingFindings(
  structure: RefactorReview,
  behavior: RefactorReview,
): RefactorReview["findings"] {
  const findings = [
    ...(structure.blocking ? structure.findings : []),
    ...(behavior.blocking ? behavior.findings : []),
  ];
  return findings.length
    ? findings
    : [{
      severity: "high",
      evidence: "review is blocking without a structured finding",
      requiredChange: "Return a nonblocking review or a structured actionable finding.",
    }];
}

function reviewFindingKey(finding: RefactorReview["findings"][number]): string {
  if (finding.id) return finding.id.toLowerCase().replace(/\s+/g, "-");
  return [finding.severity, finding.evidence, finding.requiredChange]
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function readReviewDiff(repo: string): Promise<string> {
  const diff = await git(repo, ["diff", "--no-ext-diff", "--"]);
  if (diff.code !== 0) throw new Error(diff.log || "failed to read refactor diff");
  const untracked = await untrackedFiles(repo);
  const additions = await Promise.all(untracked.map(async (path) => [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    ...renderAddedLines(await readFile(`${repo}/${path}`, "utf8")),
  ].join("\n")));
  return [diff.stdout, ...additions].filter(Boolean).join("\n");
}

async function currentBranch(repo: string): Promise<string> {
  const result = await git(repo, ["branch", "--show-current"]);
  if (result.code !== 0) throw new Error(result.log || "failed to read current branch");
  return result.stdout.trim() || "HEAD";
}

async function requireCleanTree(repo: string): Promise<void> {
  if (!(await isCleanTree(repo))) throw new Error("working tree is not clean");
}

async function changedProtectedPaths(repo: string, protectedPaths: string[] | undefined): Promise<string[]> {
  if (!protectedPaths?.length) return [];
  const changed = await reviewPaths(repo);
  const normalizedProtected = protectedPaths.map(normalizePath);
  return changed.filter((path) => normalizedProtected.some((root) =>
    path === root || path.startsWith(`${root}/`),
  ));
}

async function repairScope(
  ctx: SigilContext,
  agent: RichSigilAgent,
  repairLimit: number,
  timeoutMs: number,
  input: RefactorInput,
  stage: string,
  eventsFile: string,
  failures: WorkflowFailure[],
): Promise<boolean> {
  let repairAvailable = true;
  const result = await recover({
    limit: repairLimit,
    attempt: async () => {
      if (!repairAvailable) {
        return {
          ok: false as const,
          failure: {
            kind: "provider" as const,
            stage: `${stage}:authority-repair`,
            evidence: "protected-path repair agent operation exhausted",
            attempts: 0,
            recoverable: false,
          },
        };
      }
      const paths = await changedProtectedPaths(input.repo, input.protectedPaths);
      if (!paths.length) return { ok: true as const, value: undefined };
      return {
        ok: false as const,
        failure: {
          kind: "authority" as const,
          stage,
          evidence: `changed protected paths: ${paths.join(", ")}`,
          paths,
          attempts: 0,
          recoverable: true,
        },
      };
    },
    repair: async (failure) => {
      const repair = await promptAgentTurn(
        ctx,
        agent,
        refactorPrompt("repair-protected-paths", {
          INTENT: input.intent,
          PROTECTED_PATHS: input.protectedPaths?.join("\n") ?? "",
          FAILURE: JSON.stringify(failure, null, 2),
          DIFF: await readReviewDiff(input.repo),
        }),
        { stage: `${stage}:authority-repair`, limit: repairLimit, timeoutMs },
      );
      failures.push(...repair.failures);
      repairAvailable = repair.ok;
    },
    record: async (failure) => recordStage(eventsFile, "recovery", {
      kind: failure.kind,
      stage: failure.stage,
    }),
  });
  failures.push(...result.failures);
  if (!result.ok) {
    failures.push({ ...result.failure, recoverable: false });
    return false;
  }
  return true;
}

async function reviewPaths(repo: string): Promise<string[]> {
  const tracked = (await changedPaths(repo)).filter((path) => !path.endsWith("/"));
  return [...new Set([...tracked, ...await untrackedFiles(repo)])].sort();
}

async function untrackedFiles(repo: string): Promise<string[]> {
  const result = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.code !== 0) throw new Error(result.log || "failed to read untracked files");
  return result.stdout.split("\0").filter(Boolean).map(normalizePath);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function renderAddedLines(contents: string): string[] {
  const lines = contents.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
}

async function establishBaselineWithRecovery(
  ctx: SigilContext,
  input: RefactorInput,
  coder: string,
  repairLimit: number,
  timeoutMs: number,
  eventsFile: string,
  failures: WorkflowFailure[],
): Promise<Baseline | undefined> {
  const config = loadConfig(input.repo);
  let repairAvailable = true;
  const result = await recover({
    limit: repairLimit,
    attempt: async () => {
      if (!repairAvailable) {
        return {
          ok: false as const,
          failure: {
            kind: "provider" as const,
            stage: "baseline:repair",
            evidence: "baseline repair agent operation exhausted",
            attempts: 0,
            recoverable: false,
          },
        };
      }
      const baseline = await establishBaseline(ctx, input.repo, config);
      if (!("kind" in baseline) && baseline.verification.ok) {
        return { ok: true as const, value: baseline };
      }
      if (!("kind" in baseline)) {
        return {
          ok: false as const,
          failure: {
            kind: "baseline" as const,
            stage: "baseline",
            evidence: baseline.verification.evidence,
            attempts: 0,
            recoverable: true,
          },
        };
      }
      return { ok: false as const, failure: baseline };
    },
    repair: async (failure) => {
      const repair = await runFreshAgentOperation(
        ctx,
        coder,
        { stage: "baseline:repair", limit: repairLimit, timeoutMs },
        (agent) => agent.prompt([
          "Restore a verifiable repository baseline before refactoring.",
          "Repair only ignored dependency, cache, generated, or tool state.",
          "Do not change tracked source files or weaken verification.",
          `Failure evidence:\n${failure.evidence}`,
        ].join("\n\n")),
      );
      failures.push(...repair.failures);
      repairAvailable = repair.ok;
      if (!(await isCleanTree(input.repo))) {
        await recordStage(eventsFile, "baseline-repair-dirtied-tree");
      }
    },
    record: async (failure) => recordStage(eventsFile, "baseline-recovery", {
      attempt: String(failure.attempts),
    }),
  });
  failures.push(...result.failures);
  if (!result.ok) {
    failures.push({ ...result.failure, recoverable: false });
    return undefined;
  }
  if (!(await isCleanTree(input.repo))) {
    failures.push({
      kind: "authority",
      stage: "baseline",
      evidence: "baseline repair changed tracked repository files",
      attempts: result.attempts,
      recoverable: false,
    });
    return undefined;
  }
  return result.value;
}

function operationValue<T>(
  result: RecoveryResult<T>,
  failures: WorkflowFailure[],
): T | undefined {
  failures.push(...result.failures);
  if (result.ok) return result.value;
  return undefined;
}

async function failedResult(
  ctx: SigilContext,
  branch: string,
  eventsFile: string,
  failures: WorkflowFailure[],
  planFile?: string,
  plan?: RefactorPlan,
  repo?: string,
): Promise<RefactorResult> {
  const changedFiles = repo ? await reviewPaths(repo) : [];
  const storedPlan = planFile ?? await ctx.artifacts.write("refactor-plan.json", "{}\n");
  const structureReviewFile = await ctx.artifacts.write("refactor-structure-review.json", "{}\n");
  const behaviorReviewFile = await ctx.artifacts.write("refactor-behavior-review.json", "{}\n");
  return {
    branch,
    planFile: storedPlan,
    structureReviewFile,
    behaviorReviewFile,
    eventsFile,
    changedFiles,
    valid: false,
    issues: failures.filter((failure) => !failure.recoverable).map((failure) => failure.evidence),
    failures,
    discoveries: plan && repo
      ? discoverPaths({ repo, intent: "", focus: [] }, plan, changedFiles)
      : [],
  };
}

function promptVariables(input: RefactorInput, context: string): Record<string, string> {
  return {
    INTENT: input.intent,
    BRIEF: input.brief ?? "",
    FOCUS: input.focus?.join("\n") ?? "Inspect the repository and choose the relevant starting points.",
    PROTECTED_PATHS: input.protectedPaths?.join("\n") ?? "None.",
    CONTEXT: context,
  };
}

function discoverPaths(
  input: RefactorInput,
  plan: RefactorPlan,
  changedFiles: string[],
): PathDiscovery[] {
  const focus = (input.focus ?? []).map(normalizePath);
  return changedFiles
    .filter((path) => !focus.some((root) => path === root || path.startsWith(`${root}/`)))
    .map((path) => {
      const slice = plan.slices.find((candidate) => candidate.paths.some((root) => {
        const normalized = normalizePath(root);
        return path === normalized || path.startsWith(`${normalized}/`);
      }));
      return {
        path,
        justification: slice
          ? `${slice.description}: ${slice.expectedChange}`
          : `Required to satisfy the refactor intent: ${input.intent}`,
      };
    });
}

async function writeReview(
  ctx: SigilContext,
  name: string,
  review: RefactorReview,
): Promise<string> {
  return ctx.artifacts.write(name, `${JSON.stringify(review, null, 2)}\n`);
}

async function recordStage(
  file: string,
  stage: string,
  details: Record<string, string> = {},
): Promise<void> {
  const event = JSON.stringify({ at: new Date().toISOString(), stage, ...details });
  const suffix = Object.values(details).length
    ? ` ${Object.values(details).join(" ")}`
    : "";
  await appendFile(file, `${event}\n`);
  process.stderr.write(`[refactor] ${stage}${suffix}\n`);
}
