import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig, type SigilConfig } from "../../../config.js";
import { CONTRACT_VERSION, validateTaskGraph } from "../../../contracts/task-graph.js";
import { loadConfiguredContext, renderContextBlock, sigil } from "../../../context.js";
import type { WorkflowFailure } from "../../../recovery/index.js";
import { planningPrompts } from "./prompts.js";
import { enrichTaskGraph, repairTaskGraphJson } from "./task-graph.js";

export type PlanInput = { intent: string; repo: string; brief?: string; outFile?: string };
export type PlanResult = { taskFile: string; taskCount: number; valid: boolean; issues: string[]; failures: WorkflowFailure[] };
const contract = JSON.stringify({
  contractVersion: CONTRACT_VERSION,
  project: "short-kebab-slug",
  goal: "string optional",
  tasks: [
    {
      id: "short-stable-id",
      title: "one-line title",
      summary: "what changes and why",
      dependencies: ["earlier-task-id"],
      acceptanceCriteria: ["observable check"],
      diagrams: ["optional ASCII diagram"],
      files: [{ path: "repo/relative/path.ts", action: "create|modify|delete", details: ["symbol and line anchored detail"] }],
    },
  ],
}, null, 2);


async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}


export const plan = sigil<PlanInput, PlanResult>("plan", async (ctx, input) => {
  const config: SigilConfig = loadConfig(input.repo);
  const contextBlock = renderContextBlock(await loadConfiguredContext(input.repo, config.context));
  const taskFile = input.outFile ?? ctx.artifacts.path("task-graph.json");
  const workDir = join(dirname(taskFile), ".sigil-plan");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const failures: WorkflowFailure[] = [];

  const plannerResults = await ctx.parallel(config.plan.planners.map((name, index) => async () => {
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
      },
      async (planner) => {
        await planner.prompt(planningPrompts.investigate({ INTENT: input.intent, BRIEF: input.brief ?? "", CONTEXT: contextBlock }));
        const emitted = await plannerContext.emit(planner, planningPrompts.writePlan({ OUT_FILE: outFile }), outFile, { minBytes: 1 });
        if (!emitted.ok) throw new Error(emitted.issue);
        return { name, text: emitted.contents[0] ?? "" };
      },
    );
    failures.push(...planned.failures);
    return planned.ok ? planned.value : null;
  }));

  const plans = plannerResults.filter((result): result is { name: string; text: string } => result !== null && result.text.trim().length > 0);
  if (!plans.length) {
    return { taskFile, taskCount: 0, valid: false, issues: ["no planner produced a usable plan"], failures };
  }

  const synthesisContext = ctx.fork({
    artifactRoot: join(workDir, "synthesis"),
    operationPath: "planning/synthesis",
  });
  const synthesized = await runFreshAgentOperation(
    synthesisContext,
    config.plan.synthesizer,
    {
      stage: "planning:synthesis",
      limit: config.implement.repairLimit,
      timeoutMs: config.implement.operationTimeoutMs,
    },
    async (synthesizer) => {
    const planText = plans.map((result, index) => `----- planner ${index + 1}: ${result.name} -----\n${result.text}`).join("\n\n");
    let convergenceInput: string;
    let divergenceInput: string;

    if (plans.length > 1) {
      const convergenceFile = join(workDir, "convergence.md");
      const divergenceFile = join(workDir, "divergence.md");
      const convergenceVerifiedFile = join(workDir, "convergence-verified.md");
      const divergenceVerifiedFile = join(workDir, "divergence-verified.md");
      const resolvedFile = join(workDir, "divergence-resolved.md");

      const compared = await synthesisContext.emit(synthesizer, planningPrompts.comparePlans({ INTENT: input.intent, PLANS: planText, CONVERGE_FILE: convergenceFile, DIVERGE_FILE: divergenceFile }), [convergenceFile, divergenceFile], { minBytes: 1 });
      if (!compared.ok) throw new Error(`compare plans failed: ${compared.issue}`);
      const convergence = await readText(convergenceFile);
      const divergence = await readText(divergenceFile);

      const verified = await synthesisContext.emit(synthesizer, planningPrompts.verifyClaims({ INTENT: input.intent, CONVERGENCE: convergence, DIVERGENCE: divergence, CONVERGE_VERIFY_FILE: convergenceVerifiedFile, DIVERGE_VERIFY_FILE: divergenceVerifiedFile }), [convergenceVerifiedFile, divergenceVerifiedFile], { minBytes: 1 });
      if (!verified.ok) throw new Error(`verify claims failed: ${verified.issue}`);
      convergenceInput = await readText(convergenceVerifiedFile);
      const divergenceVerified = await readText(divergenceVerifiedFile);

      const resolved = await synthesisContext.emit(synthesizer, planningPrompts.resolveDivergences({ INTENT: input.intent, DIVERGENCE_VERIFIED: divergenceVerified, OUT_FILE: resolvedFile }), resolvedFile, { minBytes: 1 });
      if (!resolved.ok) throw new Error(`resolve divergences failed: ${resolved.issue}`);
      divergenceInput = await readText(resolvedFile);
    } else {
      convergenceInput = planText;
      divergenceInput = "Single planner; no divergences to resolve.";
    }

    const built = await synthesisContext.emit(synthesizer, planningPrompts.buildTaskGraph({ INTENT: input.intent, CONTRACT: contract, CONVERGENCE_VERIFIED: convergenceInput, DIVERGENCE_RESOLVED: divergenceInput, OUT_FILE: taskFile }), taskFile, { minBytes: 1, mustChange: true });
    if (!built.ok) throw new Error(`build task graph failed: ${built.issue}`);

    await enrichTaskGraph(synthesizer, { intent: input.intent, taskFile });
    const checked = await repairTaskGraphJson(synthesisContext, synthesizer, { taskFile, repo: input.repo, contract });

    const valid = checked.errors.length === 0 && checked.raw !== null;
    if (valid) validateTaskGraph(checked.raw, { repoRoot: input.repo });
    return { taskCount: checked.graph?.tasks.length ?? 0, valid, issues: [...synthesisContext.issues] };
    },
  );
  failures.push(...synthesized.failures);
  if (!synthesized.ok) {
    return { taskFile, taskCount: 0, valid: false, issues: [synthesized.failure.evidence], failures };
  }
  return { taskFile, ...synthesized.value, failures };
});
