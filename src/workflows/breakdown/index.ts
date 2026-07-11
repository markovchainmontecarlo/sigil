import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig, type SigilConfig } from "../../config.js";
import {
  BACKLOG_CONTRACT_VERSION,
  checkBacklog,
  orderItems,
  validateBacklog,
  type Backlog,
} from "../../contracts/backlog.js";
import { sigil } from "../../context.js";
import { breakdownPrompts } from "./prompts.js";

export type BreakdownInput = { mission: string; repo: string; outFile?: string };
export type BreakdownResult = { backlogFile: string; itemCount: number; valid: boolean; issues: string[] };
type BacklogRead = { raw: unknown | null; backlog: Backlog | null; errors: string[] };

const contract = JSON.stringify({
  contractVersion: BACKLOG_CONTRACT_VERSION,
  mission: "mission text",
  items: [
    {
      id: "short-stable-id",
      goal: "one outcome this item delivers",
      dependsOn: ["earlier-item-id"],
      brief: "self-contained intent paragraph with goal, constraints, and acceptance sketch",
    },
  ],
}, null, 2);

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

async function readBacklog(file: string): Promise<BacklogRead> {
  try {
    const raw = JSON.parse(await readText(file));
    return { raw, ...checkBacklog(raw) };
  } catch (error) {
    return { raw: null, backlog: null, errors: [`backlog JSON parse failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function cutsText(cuts: Array<{ name: string; text: string }>): string {
  return cuts.map((result, index) => `----- planner ${index + 1}: ${result.name} -----\n${result.text}`).join("\n\n");
}

async function writeDependencyOrder(file: string, backlog: Backlog): Promise<Backlog> {
  const ordered = orderItems(backlog);
  const currentIds = backlog.items.map((item) => item.id).join("\n");
  const orderedIds = ordered.map((item) => item.id).join("\n");
  if (currentIds === orderedIds) return backlog;
  const reordered = { ...backlog, items: ordered };
  await writeFile(file, `${JSON.stringify(reordered, null, 2)}\n`);
  return reordered;
}

export const breakdown = sigil<BreakdownInput, BreakdownResult>("breakdown", async (ctx, input) => {
  const config: SigilConfig = loadConfig(input.repo);
  const backlogFile = input.outFile ?? ctx.artifacts.path("backlog.json");
  const workDir = join(dirname(backlogFile), ".sigil-breakdown");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const plannerResults = await ctx.parallel(config.plan.planners.map((name, index) => async () => {
    await using planner = ctx.agent(name);
    const outFile = join(workDir, `cut-${index}.md`);
    try {
      const emitted = await ctx.emit(planner, breakdownPrompts.cut({ MISSION: input.mission, OUT_FILE: outFile }), outFile, { minBytes: 1 });
      if (!emitted.ok) {
        ctx.issue(`planner ${index} (${name}) failed: ${emitted.issue}`);
        return null;
      }
      return { name, text: emitted.contents[0] ?? "" };
    } catch (error) {
      ctx.issue(`planner ${index} (${name}) failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }));

  const cuts = plannerResults.filter((result): result is { name: string; text: string } => result !== null && result.text.trim().length > 0);
  if (!cuts.length) {
    ctx.issue("no planner produced a usable breakdown cut");
    return { backlogFile, itemCount: 0, valid: false, issues: [...ctx.issues] };
  }

  try {
    await using synthesizer = ctx.agent(config.plan.synthesizer);
    const merged = await ctx.emit(
      synthesizer,
      breakdownPrompts.merge({ MISSION: input.mission, CUTS: cutsText(cuts), CONTRACT: contract, OUT_FILE: backlogFile }),
      backlogFile,
      { minBytes: 1, mustChange: true },
    );
    if (!merged.ok) ctx.issue(`merge backlog failed: ${merged.issue}`);

    await synthesizer.prompt(breakdownPrompts.briefs({ MISSION: input.mission, BACKLOG: await readText(backlogFile), OUT_FILE: backlogFile }));

    let checked = await readBacklog(backlogFile);
    if (checked.errors.length) ctx.issue(`backlog repair ran: ${checked.errors.join("; ")}`);
    for (let attempt = 0; checked.errors.length && attempt < 3; attempt++) {
      await synthesizer.prompt(breakdownPrompts.fixJson({ FILE: backlogFile, CONTRACT: contract, ERRORS: checked.errors.join("\n") }));
      checked = await readBacklog(backlogFile);
    }
    if (checked.errors.length) ctx.issue(`backlog still invalid: ${checked.errors.join("; ")}`);

    let backlog = checked.backlog;
    if (checked.errors.length === 0 && backlog) {
      try {
        backlog = await writeDependencyOrder(backlogFile, backlog);
      } catch (error) {
        checked = { ...checked, errors: [error instanceof Error ? error.message : String(error)] };
        ctx.issue(`backlog ordering failed: ${checked.errors.join("; ")}`);
      }
    }

    const valid = checked.errors.length === 0 && checked.raw !== null && backlog !== null;
    if (valid) validateBacklog(backlog);
    return { backlogFile, itemCount: backlog?.items.length ?? 0, valid, issues: [...ctx.issues] };
  } catch (error) {
    return { backlogFile, itemCount: 0, valid: false, issues: [...ctx.issues, error instanceof Error ? error.message : String(error)] };
  }
});
