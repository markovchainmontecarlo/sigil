import { loadConfig } from "../config.js";
import { publish } from "../git.js";
import { implement } from "../workflows/software-change/implementation/index.js";
import { plan } from "../workflows/software-change/planning/index.js";
import { review } from "../workflows/software-change/review/index.js";
import { softwareChange } from "../workflows/software-change/workflow.js";
import { implementExitCode, reviewExitCode, softwareChangeExitCode } from "./exit-codes.js";
import { readOptionalFile } from "./input.js";
import { printJson } from "./output.js";
import { parseCommandArgs, rejectPositionals, requireValue, value } from "./parse.js";

export async function planCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    intent: { type: "string" },
    brief: { type: "string" },
    out: { type: "string" },
  });
  rejectPositionals(parsed);

  const result = await plan({
    repo: requireValue(parsed, "repo"),
    intent: requireValue(parsed, "intent"),
    brief: await readOptionalFile(value(parsed, "brief")),
    outFile: value(parsed, "out"),
  });
  printJson(result);
  return result.valid ? 0 : 1;
}

export async function softwareChangeCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    intent: { type: "string" },
    brief: { type: "string" },
    out: { type: "string" },
    "task-file": { type: "string" },
    branch: { type: "string" },
    instructions: { type: "string" },
  });
  rejectPositionals(parsed);

  const result = await softwareChange({
    repo: requireValue(parsed, "repo"),
    intent: requireValue(parsed, "intent"),
    brief: await readOptionalFile(value(parsed, "brief")),
    outFile: value(parsed, "out"),
    taskFile: value(parsed, "task-file"),
    branch: value(parsed, "branch"),
    instructions: await readOptionalFile(value(parsed, "instructions")),
  });
  printJson(result);
  return softwareChangeExitCode(result);
}

export async function implementCommand(args: string[]): Promise<number> {
  return implementCommandWith(args, { implement, publish });
}

type ImplementCommandEffects = {
  implement: (input: Parameters<typeof implement>[0]) => ReturnType<typeof implement>;
  publish: (repo: Parameters<typeof publish>[0], input: Parameters<typeof publish>[1]) => ReturnType<typeof publish>;
};

export async function implementCommandWith(args: string[], effects: ImplementCommandEffects): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    "task-file": { type: "string" },
    branch: { type: "string" },
    instructions: { type: "string" },
    publish: { type: "boolean" },
  });
  rejectPositionals(parsed);

  const repo = requireValue(parsed, "repo");
  const result = await effects.implement({
    repo,
    taskFile: requireValue(parsed, "task-file"),
    branch: value(parsed, "branch"),
    instructions: await readOptionalFile(value(parsed, "instructions")),
  });
  const base = loadConfig(repo).implement.baseBranch;
  const deliverable = !result.reviewBlocking
    && result.failedTasks.length === 0
    && result.issues.length === 0;
  const publicationRequested = parsed.values.publish === true;
  const published = deliverable && publicationRequested
    ? await effects.publish(repo, { branch: result.branch, title: result.branch, body: result.prBody, base })
    : null;
  printJson({ implement: result, publish: published });
  return implementExitCode(result, published, publicationRequested);
}

export async function reviewCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    base: { type: "string" },
    "no-autofix": { type: "boolean" },
    context: { type: "string" },
  });
  rejectPositionals(parsed);

  const result = await review({
    repo: requireValue(parsed, "repo"),
    base: requireValue(parsed, "base"),
    autofix: !parsed.values["no-autofix"],
    context: value(parsed, "context"),
  });
  printJson(result);
  return reviewExitCode(result);
}
