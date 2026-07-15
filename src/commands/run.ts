import { launchTypeScriptSigil, runTypeScriptSigil, SigilRunnerError } from "../sigil-runner.js";
import type { RunPersistence } from "../storage.js";
import { runYamlWorkflowFile } from "../yaml/run.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, rejectPositionals, requireValue, value } from "./parse.js";

export async function runWorkflowCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    file: { type: "string" },
  });
  rejectPositionals(parsed);

  const result = await runYamlWorkflowFile(requireValue(parsed, "file"), requireValue(parsed, "repo"));
  printJson(result);
  return result.issues.length === 0 ? 0 : 1;
}

export async function runSigilCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    file: { type: "string" },
    input: { type: "string" },
    out: { type: "string" },
    "run-dir": { type: "string" },
    persistence: { type: "string" },
    foreground: { type: "boolean" },
  });
  rejectPositionals(parsed);

  try {
    const input = {
      repo: requireValue(parsed, "repo"),
      file: requireValue(parsed, "file"),
      inputFile: value(parsed, "input"),
      outFile: value(parsed, "out"),
      runDir: value(parsed, "run-dir"),
      persistence: parsePersistence(value(parsed, "persistence")),
    };
    const result = parsed.values.foreground === true
      ? await runTypeScriptSigil(input)
      : await launchTypeScriptSigil(input);
    printJson(result);
    return 0;
  } catch (error) {
    if (error instanceof SigilRunnerError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function parsePersistence(value: string | undefined): RunPersistence {
  if (value === undefined || value === "durable") return "durable";
  if (value === "ephemeral") return "ephemeral";
  throw new UsageError(`invalid --persistence: ${value}`);
}
