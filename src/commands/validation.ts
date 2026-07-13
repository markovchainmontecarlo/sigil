import { validateTypeScriptSigil } from "../sigil-runner.js";
import { validateYamlWorkflowFile } from "../yaml/run.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, value } from "./parse.js";

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
