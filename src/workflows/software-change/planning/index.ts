import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig, type SigilConfig } from "../../../config.js";
import { CONTRACT_VERSION, validateTaskGraph } from "../../../contracts/task-graph.js";
import {
  loadConfiguredContext,
  renderContextBlock,
  sigil,
  type RichSigilAgent,
  type SigilContext,
} from "../../../context.js";
import type { WorkflowFailure } from "../../../recovery/index.js";
import { planningPrompts } from "./prompts.js";
import { convergePlanningReview } from "./review.js";
import {
  enrichTaskGraph,
  repairTaskGraphJson,
  type TaskGraphCheck,
} from "./task-graph.js";

export type PlanInput = { intent: string; repo: string; brief?: string; outFile?: string };
export type PlanResult = { taskFile: string; taskCount: number; valid: boolean; issues: string[]; failures: WorkflowFailure[] };

type CandidatePlan = { name: string; text: string };
type SynthesizedPlan = { checked: TaskGraphCheck; crosswalk: string; issues: string[] };

const contract = JSON.stringify({
  contractVersion: CONTRACT_VERSION,
  project: "short-kebab-slug",
  goal: "observable outcome",
  architecture: "ownership boundary, state flow, dependency direction, and selected approach",
  constraints: ["requirements every task preserves"],
  nonGoals: ["explicitly excluded work"],
  tasks: [{
    id: "short-stable-id",
    title: "one-line title",
    summary: "what changes and why",
    dependencies: ["earlier-task-id"],
    interfaces: {
      produces: [{ name: "stable-output-name", description: "behavior guaranteed to dependents" }],
      consumes: [{ taskId: "producer-task-id", name: "stable-output-name", description: "how this task uses it" }],
    },
    acceptanceCriteria: ["observable outcome"],
    verification: [
      { kind: "command", command: "focused command", expected: "expected result" },
      { kind: "manual", procedure: "manual procedure", expected: "expected observation", rationale: "why automation is unsuitable" },
    ],
    diagrams: ["optional ASCII diagram"],
    files: [{
      path: "repo/relative/path.ts",
      action: "create|modify|delete",
      details: ["stable symbol or structural anchor and intended change"],
    }],
  }],
}, null, 2);

async function collectCandidatePlans(
  ctx: SigilContext,
  input: PlanInput,
  config: SigilConfig,
  workDir: string,
  contextBlock: string,
  rubric: string,
): Promise<{ plans: CandidatePlan[]; failures: WorkflowFailure[] }> {
  const results = await ctx.parallel(config.plan.planners.map((name, index) => async () => {
    const outFile = join(workDir, `plan-${index}.md`);
    const plannerContext = ctx.fork({
      artifactRoot: join(workDir, `planner-${index}`),
      operationPath: `planning/planner-${index}`,
    });
    const planned = await runFreshAgentOperation(
      plannerContext,
      name,
      {
        stage: `planning:planner:${index}`,
        limit: config.implement.repairLimit,
        timeoutMs: config.implement.operationTimeoutMs,
        idleTimeoutMs: config.implement.idleTimeoutMs,
      },
      async (planner) => {
        await planner.prompt(planningPrompts.investigate({
          RUBRIC: rubric,
          INTENT: input.intent,
          BRIEF: input.brief ?? "",
          CONTEXT: contextBlock,
        }));
        const emitted = await plannerContext.emit(
          planner,
          planningPrompts.writePlan({ RUBRIC: rubric, OUT_FILE: outFile }),
          outFile,
          { minBytes: 1 },
        );
        if (!emitted.ok) throw new Error(emitted.issue);
        return { name, text: emitted.contents[0] ?? "" };
      },
    );
    return { planned };
  }));

  const failures = results.flatMap(({ planned }) => planned.failures);
  const plans = results
    .flatMap(({ planned }) => planned.ok ? [planned.value] : [])
    .filter((result) => result.text.trim().length > 0);
  return { plans, failures };
}

function renderCandidatePlans(plans: CandidatePlan[]): string {
  return plans
    .map((result, index) => `----- planner ${index + 1}: ${result.name} -----\n${result.text}`)
    .join("\n\n");
}

async function compareAndVerifyPlans(
  ctx: SigilContext,
  synthesizer: RichSigilAgent,
  input: PlanInput,
  planText: string,
  workDir: string,
  rubric: string,
): Promise<{ convergence: string; divergence: string; crosswalk: string }> {
  const convergenceFile = join(workDir, "convergence.md");
  const divergenceFile = join(workDir, "divergence.md");
  const crosswalkFile = join(workDir, "requirements-crosswalk.md");
  const convergenceVerifiedFile = join(workDir, "convergence-verified.md");
  const divergenceVerifiedFile = join(workDir, "divergence-verified.md");
  const crosswalkVerifiedFile = join(workDir, "requirements-crosswalk-verified.md");
  const resolvedFile = join(workDir, "divergence-resolved.md");

  const compared = await ctx.emit(
    synthesizer,
    planningPrompts.comparePlans({
      RUBRIC: rubric,
      INTENT: input.intent,
      PLANS: planText,
      CONVERGE_FILE: convergenceFile,
      DIVERGE_FILE: divergenceFile,
      CROSSWALK_FILE: crosswalkFile,
    }),
    [convergenceFile, divergenceFile, crosswalkFile],
    { minBytes: 1 },
  );
  if (!compared.ok) throw new Error(`compare plans failed: ${compared.issue}`);

  const [convergence = "", divergence = "", crosswalk = ""] = compared.contents;
  const verified = await ctx.emit(
    synthesizer,
    planningPrompts.verifyClaims({
      INTENT: input.intent,
      CONVERGENCE: convergence,
      DIVERGENCE: divergence,
      CROSSWALK: crosswalk,
      CONVERGE_VERIFY_FILE: convergenceVerifiedFile,
      DIVERGE_VERIFY_FILE: divergenceVerifiedFile,
      CROSSWALK_VERIFY_FILE: crosswalkVerifiedFile,
    }),
    [convergenceVerifiedFile, divergenceVerifiedFile, crosswalkVerifiedFile],
    { minBytes: 1 },
  );
  if (!verified.ok) throw new Error(`verify claims failed: ${verified.issue}`);

  const [convergenceVerified = "", divergenceVerified = "", crosswalkVerified = ""] = verified.contents;
  const resolved = await ctx.emit(
    synthesizer,
    planningPrompts.resolveDivergences({
      INTENT: input.intent,
      DIVERGENCE_VERIFIED: divergenceVerified,
      CROSSWALK_VERIFIED: crosswalkVerified,
      OUT_FILE: resolvedFile,
    }),
    resolvedFile,
    { minBytes: 1 },
  );
  if (!resolved.ok) throw new Error(`resolve divergences failed: ${resolved.issue}`);

  return {
    convergence: convergenceVerified,
    divergence: resolved.contents[0] ?? "",
    crosswalk: crosswalkVerified,
  };
}

async function synthesizeTaskGraph(
  ctx: SigilContext,
  input: PlanInput,
  config: SigilConfig,
  plans: CandidatePlan[],
  workDir: string,
  taskFile: string,
  rubric: string,
): Promise<{ result?: SynthesizedPlan; failures: WorkflowFailure[]; issue?: string }> {
  const planText = renderCandidatePlans(plans);
  const synthesized = await runFreshAgentOperation(
    ctx,
    config.plan.synthesizer,
    {
      stage: "planning:synthesis",
      limit: config.implement.repairLimit,
      timeoutMs: config.implement.operationTimeoutMs,
      idleTimeoutMs: config.implement.idleTimeoutMs,
    },
    async (synthesizer) => {
      const evidence = plans.length > 1
        ? await compareAndVerifyPlans(ctx, synthesizer, input, planText, workDir, rubric)
        : {
            convergence: planText,
            divergence: "Single planner; no divergences to resolve.",
            crosswalk: planText,
          };

      const built = await ctx.emit(
        synthesizer,
        planningPrompts.buildTaskGraph({
          RUBRIC: rubric,
          INTENT: input.intent,
          CONTRACT: contract,
          CONVERGENCE_VERIFIED: evidence.convergence,
          DIVERGENCE_RESOLVED: evidence.divergence,
          CROSSWALK_VERIFIED: evidence.crosswalk,
          OUT_FILE: taskFile,
        }),
        taskFile,
        { minBytes: 1, mustChange: true },
      );
      if (!built.ok) throw new Error(`build task graph failed: ${built.issue}`);

      await enrichTaskGraph(synthesizer, { intent: input.intent, taskFile });
      const checked = await repairTaskGraphJson(ctx, synthesizer, {
        taskFile,
        repo: input.repo,
        contract,
        limit: config.implement.repairLimit,
      });
      return { checked, crosswalk: evidence.crosswalk, issues: [...ctx.issues] };
    },
  );

  if (!synthesized.ok) {
    return { failures: synthesized.failures, issue: synthesized.failure.evidence };
  }
  return { result: synthesized.value, failures: synthesized.failures };
}

export const plan = sigil<PlanInput, PlanResult>("plan", async (ctx, input) => {
  const config = loadConfig(input.repo);
  const contextBlock = renderContextBlock(await loadConfiguredContext(input.repo, config.context));
  const plannerRubric = planningPrompts.plannerRubric();
  const synthesisRubric = planningPrompts.synthesisRubric();
  const taskFile = input.outFile ?? ctx.artifacts.path("task-graph.json");
  const workDir = join(dirname(taskFile), ".sigil-plan");

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const candidates = await collectCandidatePlans(
    ctx,
    input,
    config,
    workDir,
    contextBlock,
    plannerRubric,
  );
  if (!candidates.plans.length) {
    return {
      taskFile,
      taskCount: 0,
      valid: false,
      issues: ["no planner produced a usable plan"],
      failures: candidates.failures,
    };
  }

  const synthesisContext = ctx.fork({
    artifactRoot: join(workDir, "synthesis"),
    operationPath: "planning/synthesis",
  });
  const synthesized = await synthesizeTaskGraph(
    synthesisContext,
    input,
    config,
    candidates.plans,
    workDir,
    taskFile,
    synthesisRubric,
  );
  const failures = [...candidates.failures, ...synthesized.failures];
  if (!synthesized.result) {
    return {
      taskFile,
      taskCount: 0,
      valid: false,
      issues: [synthesized.issue ?? "task graph synthesis failed"],
      failures,
    };
  }
  if (synthesized.result.checked.errors.length) {
    return {
      taskFile,
      taskCount: synthesized.result.checked.graph?.tasks.length ?? 0,
      valid: false,
      issues: [...synthesized.result.issues, ...synthesized.result.checked.errors],
      failures,
    };
  }

  const convergence = await convergePlanningReview(ctx, {
    repo: input.repo,
    intent: input.intent,
    brief: input.brief ?? "",
    taskFile,
    crosswalk: synthesized.result.crosswalk,
    contract,
    rubric: `${plannerRubric}\n\n${synthesisRubric}`,
    config,
  });
  failures.push(...convergence.failures);

  const issues = [
    ...synthesized.result.issues,
    ...convergence.checked.errors,
    ...convergence.issues,
  ];
  const valid = issues.length === 0 && convergence.checked.raw !== null;
  if (valid) validateTaskGraph(convergence.checked.raw, { repoRoot: input.repo });
  return {
    taskFile,
    taskCount: convergence.checked.graph?.tasks.length ?? 0,
    valid,
    issues,
    failures,
  };
});
