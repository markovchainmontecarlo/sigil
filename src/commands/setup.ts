import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_FILE, DEFAULT_SIGIL_CONFIG } from "../config.js";
import { discoverProjectEvals, resolveRepositoryRoot } from "../repository-setup.js";
import { parseCommandArgs, rejectPositionals, value } from "./parse.js";

const RUN_DIRECTORY_IGNORE = "/.sigil/runs/";

export async function setupCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    dir: { type: "string" },
    force: { type: "boolean" },
  });
  rejectPositionals(parsed);

  const requested = resolve(value(parsed, "dir") ?? process.cwd());
  const repo = await resolveRepositoryRoot(requested);
  const evals = await discoverProjectEvals(repo);
  const config = { ...DEFAULT_SIGIL_CONFIG, evals };
  const configPath = join(repo, CONFIG_FILE);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await writeFile(configPath, body, { flag: parsed.values.force ? "w" : "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      console.error(`${configPath} already exists; use --force to overwrite`);
      return 1;
    }
    throw error;
  }

  await ensureRunDirectoryIgnored(repo);
  printSetupReport(repo, configPath, config);
  return 0;
}

function printSetupReport(
  repo: string,
  configPath: string,
  config: typeof DEFAULT_SIGIL_CONFIG,
): void {
  console.log(`Created ${configPath}`);
  console.log(`\nRepository:\n  ${repo}`);
  console.log("\nAgents added:");
  for (const [name, binding] of Object.entries(config.agents)) {
    console.log(`  ${name.padEnd(14)} ${binding.provider}  ${binding.model}`);
  }

  const evals = Object.entries(config.evals);
  console.log("\nVerification added:");
  if (evals.length === 0) {
    console.log("  No unambiguous build or test commands were found.");
    console.log("\nReview the agent bindings and add repository verification commands under `evals` before running an implementation workflow.");
    console.log("Guide: docs/tutorials/first-change-with-ai-assistant.md");
    return;
  }

  for (const [name, definition] of evals) {
    const command = typeof definition === "string" ? definition : definition.command;
    console.log(`  ${name.padEnd(6)} ${command}`);
  }
  console.log("\nThe verification commands were detected but not run.");
  if (!("build" in config.evals) && !("test" in config.evals)) {
    console.log("No build or test command was detected. Add one under `evals` before running implementation.");
  }
  console.log("Review the agent bindings and verification commands before using Sigil.");
  console.log("Guide: docs/tutorials/first-change-with-ai-assistant.md");
}

async function ensureRunDirectoryIgnored(repo: string): Promise<void> {
  const ignorePath = join(repo, ".gitignore");
  const current = await readOptionalText(ignorePath);
  if (current.split(/\r?\n/).includes(RUN_DIRECTORY_IGNORE)) return;

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await writeFile(ignorePath, `${current}${separator}${RUN_DIRECTORY_IGNORE}\n`);
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}
