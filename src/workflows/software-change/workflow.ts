import { readFile } from "node:fs/promises";

import { validateTaskGraph } from "../../contracts/task-graph.js";
import { sigil } from "../../context.js";
import { requireImplementationVerification } from "../../repository-setup.js";
import { implement, type ImplementInput, type ImplementResult } from "./implementation/index.js";
import { plan, type PlanInput, type PlanResult } from "./planning/index.js";

export type SoftwareChangeInput = {
  intent: string;
  repo: string;
  brief?: string;
  instructions?: string;
  outFile?: string;
  taskFile?: string;
  branch?: string;
  baseBranch?: string;
  canonicalGraphFile?: string;
  checkpointFile?: string;
  resume?: boolean;
};

export type SoftwareChangeStage = "planning" | "implementation";

export type SoftwareChangeResult = {
  stage: SoftwareChangeStage;
  taskFile: string;
  taskCount: number;
  valid: boolean;
  plan: PlanResult;
  implementation?: ImplementResult;
  branch?: string;
  prBody?: string;
  reviewBlocking: boolean;
  issues: string[];
  failedTasks: string[];
  noopTasks: string[];
};

function planInput(input: SoftwareChangeInput): PlanInput {
  return {
    intent: input.intent,
    repo: input.repo,
    brief: input.brief,
    outFile: input.outFile,
  };
}

async function planFromTaskFile(input: SoftwareChangeInput): Promise<PlanResult> {
  if (!input.taskFile) throw new Error("missing taskFile");

  const graph = validateTaskGraph(JSON.parse(await readFile(input.taskFile, "utf8")), { repoRoot: input.repo });
  return {
    taskFile: input.taskFile,
    taskCount: graph.tasks.length,
    valid: true,
    issues: [],
    failures: [],
  };
}

function implementInput(input: SoftwareChangeInput, planned: PlanResult): ImplementInput {
  return {
    repo: input.repo,
    taskFile: planned.taskFile,
    branch: input.branch,
    baseBranch: input.baseBranch,
    brief: input.brief,
    instructions: input.instructions,
    canonicalGraphFile: input.canonicalGraphFile,
    checkpointFile: input.checkpointFile,
    resume: input.resume,
  };
}

function stoppedAfterPlanning(planned: PlanResult): SoftwareChangeResult {
  return {
    stage: "planning",
    taskFile: planned.taskFile,
    taskCount: planned.taskCount,
    valid: false,
    plan: planned,
    reviewBlocking: true,
    issues: planned.issues,
    failedTasks: [],
    noopTasks: [],
  };
}

function completed(planned: PlanResult, implemented: ImplementResult): SoftwareChangeResult {
  return {
    stage: "implementation",
    taskFile: planned.taskFile,
    taskCount: planned.taskCount,
    valid: planned.valid && planned.issues.length === 0 && implemented.issues.length === 0 && !implemented.reviewBlocking && implemented.failedTasks.length === 0,
    plan: planned,
    implementation: implemented,
    branch: implemented.branch,
    prBody: implemented.prBody,
    reviewBlocking: implemented.reviewBlocking,
    issues: [...planned.issues, ...implemented.issues],
    failedTasks: implemented.failedTasks,
    noopTasks: implemented.noopTasks,
  };
}

export const softwareChange = sigil<SoftwareChangeInput, SoftwareChangeResult>("software-change", async (ctx, input) => {
  if (input.resume && !input.taskFile) throw new Error("implementation resume requires an accepted taskFile");

  const suppliedPlan = input.taskFile ? await planFromTaskFile(input) : undefined;
  if (suppliedPlan && !suppliedPlan.valid) return stoppedAfterPlanning(suppliedPlan);

  requireImplementationVerification(input.repo);
  const planned = suppliedPlan ?? await ctx.run(plan, planInput(input));
  if (!planned.valid) return stoppedAfterPlanning(planned);

  const implemented = await ctx.run(implement, implementInput(input, planned));
  return completed(planned, implemented);
});
