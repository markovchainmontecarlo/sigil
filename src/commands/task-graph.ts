import { readFile, writeFile } from "node:fs/promises";

import { checkTaskGraph, taskGraphJsonSchema } from "../contracts/task-graph.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, value } from "./parse.js";

type ValidationRecord = {
  version: 1;
  kind: "task-graph-validation";
  valid: boolean;
  taskCount: number;
  errors: string[];
};

function validationRecord(errors: string[], taskCount: number): ValidationRecord {
  return { version: 1, kind: "task-graph-validation", valid: errors.length === 0, taskCount, errors };
}

function renderValidation(record: ValidationRecord): string {
  if (record.valid) return `Task graph is valid (${record.taskCount} tasks).`;
  return ["Task graph is invalid:", ...record.errors.map((error) => `- ${error}`)].join("\n");
}

async function validateTaskGraphCommand(taskFile: string, repo: string | undefined, json: boolean): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(taskFile, "utf8"));
    const checked = checkTaskGraph(raw, { repoRoot: repo });
    const record = validationRecord(checked.errors, checked.graph?.tasks.length ?? 0);
    if (json) printJson(record);
    else console.log(renderValidation(record));
    return record.valid ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = validationRecord([`task graph read/parse failed: ${message}`], 0);
    if (json) printJson(record);
    else console.log(renderValidation(record));
    return 1;
  }
}

async function writeTaskGraphSchema(outFile: string | undefined): Promise<number> {
  const body = `${JSON.stringify(taskGraphJsonSchema, null, 2)}\n`;
  if (outFile) await writeFile(outFile, body);
  else process.stdout.write(body);
  return 0;
}

export async function taskGraphCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    json: { type: "boolean" },
    out: { type: "string" },
  });
  const [action, file, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError("unexpected task-graph arguments");

  if (action === "validate" && file) {
    if (value(parsed, "out")) throw new UsageError("task-graph validate does not accept --out");
    return validateTaskGraphCommand(file, value(parsed, "repo"), parsed.values.json === true);
  }
  if (action === "schema" && !file) {
    if (value(parsed, "repo") || parsed.values.json) throw new UsageError("task-graph schema accepts only --out");
    return writeTaskGraphSchema(value(parsed, "out"));
  }
  throw new UsageError("expected task-graph validate <file> or task-graph schema");
}
