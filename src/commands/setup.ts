import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_FILE, DEFAULT_SIGIL_CONFIG } from "../config.js";
import { parseCommandArgs, rejectPositionals, value } from "./parse.js";

const RUN_DIRECTORY_IGNORE = "/.sigil/runs/";

export async function setupCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    dir: { type: "string" },
    force: { type: "boolean" },
  });
  rejectPositionals(parsed);

  const repo = resolve(value(parsed, "dir") ?? process.cwd());
  const configPath = join(repo, CONFIG_FILE);
  const body = `${JSON.stringify(DEFAULT_SIGIL_CONFIG, null, 2)}\n`;
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
  console.log(configPath);
  console.log("Next: discuss a bounded change with your AI assistant, then ask it to create and validate a Sigil task graph.");
  console.log("Guide: docs/tutorials/first-change-with-ai-assistant.md");
  return 0;
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
