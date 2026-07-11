import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RUN_STORAGE_IGNORE = "/.sigil/runs/";

/**
 * Creates an isolated artifact root for one workflow invocation. Git ignore
 * configuration owns the cleanliness boundary for durable local run state.
 */
export function createArtifactRoot(repo: string): string {
  ensureRunStorageIgnored(repo);
  const runs = join(resolve(repo), ".sigil", "runs");
  mkdirSync(runs, { recursive: true });
  return join(mkdtempSync(join(runs, "run-")), "artifacts");
}

export function ensureRunStorageIgnored(repo: string): void {
  const resolved = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { cwd: repo, encoding: "utf8" },
  );
  if (resolved.status !== 0) return;

  const excludeFile = resolved.stdout.trim();
  const current = readFileSync(excludeFile, "utf8");
  if (current.split(/\r?\n/).includes(RUN_STORAGE_IGNORE)) return;

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  appendFileSync(excludeFile, `${separator}${RUN_STORAGE_IGNORE}\n`);
}
