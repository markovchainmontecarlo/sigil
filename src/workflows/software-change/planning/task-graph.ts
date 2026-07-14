import { readFile } from "node:fs/promises";

import { checkTaskGraph, type TaskGraph } from "../../../contracts/task-graph.js";
import type { RichSigilAgent, SigilContext } from "../../../context.js";
import { planningPrompts } from "./prompts.js";

export type TaskGraphCheck = { raw: unknown | null; graph: TaskGraph | null; errors: string[] };

export async function enrichTaskGraph(
  agent: RichSigilAgent,
  input: { intent: string; taskFile: string },
): Promise<void> {
  await agent.prompt(planningPrompts.enrichTaskGraph({
    INTENT: input.intent,
    TASK_GRAPH: await readFile(input.taskFile, "utf8"),
    OUT_FILE: input.taskFile,
  }));
}

export async function repairTaskGraphJson(
  ctx: SigilContext,
  agent: RichSigilAgent,
  input: { taskFile: string; repo: string; contract: string; limit: number; issuePrefix?: string },
): Promise<TaskGraphCheck> {
  const label = input.issuePrefix ?? "task graph";
  let checked = await readTaskGraph(input.taskFile, input.repo);
  const repairNeeded = checked.errors.length > 0;
  if (repairNeeded) {
    await ctx.observe("task-graph-repair-started", {
      taskGraph: label,
      errors: checked.errors.join("; "),
    });
  }

  for (let attempt = 0; checked.errors.length && attempt < input.limit; attempt++) {
    await agent.prompt(planningPrompts.fixJson({
      FILE: input.taskFile,
      CONTRACT: input.contract,
      ERRORS: checked.errors.join("\n"),
    }));
    checked = await readTaskGraph(input.taskFile, input.repo);
    await ctx.observe("task-graph-repair-attempted", {
      taskGraph: label,
      attempt: String(attempt + 1),
      outcome: checked.errors.length ? "invalid" : "valid",
      errors: checked.errors.join("; "),
    });
  }

  if (checked.errors.length) {
    ctx.issue(`${label} still invalid: ${checked.errors.join("; ")}`);
    await ctx.observe("task-graph-repair-exhausted", {
      taskGraph: label,
      errors: checked.errors.join("; "),
    });
  } else if (repairNeeded) {
    await ctx.observe("task-graph-repair-completed", {
      taskGraph: label,
      outcome: "valid",
    });
  }

  return checked;
}

export async function readTaskGraph(file: string, repo: string): Promise<TaskGraphCheck> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return { raw, ...checkTaskGraph(raw, { repoRoot: repo }) };
  } catch (error) {
    return { raw: null, graph: null, errors: [`task graph JSON parse failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
