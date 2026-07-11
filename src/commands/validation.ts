import { readFile } from "node:fs/promises";

import { checkTaskGraph } from "../contracts/task-graph.js";
import { validateTypeScriptSigil } from "../sigil-runner.js";
import { validateYamlWorkflowFile } from "../yaml/run.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, value } from "./parse.js";

export async function validateCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
  });
  const taskFile = parsed.positionals[0];
  if (!taskFile || parsed.positionals.length !== 1) throw new UsageError("expected one task graph file");

  try {
    const raw = JSON.parse(await readFile(taskFile, "utf8"));
    const { errors } = checkTaskGraph(raw, { repoRoot: value(parsed, "repo") });
    printJson(errors);
    return errors.length === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson([`task graph read/parse failed: ${message}`]);
    return 1;
  }
}

export async function validateWorkflowCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
  });
  const workflowFile = parsed.positionals[0];
  if (!workflowFile || parsed.positionals.length !== 1) throw new UsageError("expected one workflow file");

  try {
    const checked = validateYamlWorkflowFile(workflowFile, value(parsed, "repo") ?? process.cwd());
    printJson(checked.errors);
    return checked.errors.length === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson([`workflow read/parse failed: ${message}`]);
    return 1;
  }
}

export async function validateSigilCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  const workflowFile = parsed.positionals[0];
  if (!workflowFile || parsed.positionals.length !== 1) throw new UsageError("expected one TypeScript sigil file");

  const checked = await validateTypeScriptSigil(workflowFile);
  printJson(checked.errors);
  return checked.valid ? 0 : 1;
}
