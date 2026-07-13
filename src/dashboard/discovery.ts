import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_DEPTH = 12;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

export function defaultDashboardRoots(sigilHome = process.env.SIGIL_HOME): string[] {
  const home = resolve(sigilHome ?? join(homedir(), ".sigil"));
  return [join(home, "runs"), join(home, "workspaces")];
}

export async function discoverRunDirectories(
  roots: string[],
  maxDepth = DEFAULT_DEPTH,
): Promise<string[]> {
  const candidates = new Set<string>();
  const queue = roots.map((root) => ({ dir: resolve(root), depth: 0 }));

  while (queue.length) {
    const batch = queue.splice(0, 64);
    const discovered = await Promise.all(batch.map((entry) => inspectDirectory(entry, maxDepth)));
    for (const result of discovered) {
      if (result.run) candidates.add(result.run);
      queue.push(...result.children);
    }
  }

  return [...candidates].sort();
}

async function inspectDirectory(
  current: { dir: string; depth: number },
  maxDepth: number,
): Promise<{ run?: string; children: Array<{ dir: string; depth: number }> }> {
  if (current.depth > maxDepth) return { children: [] };

  const entries = await readDirectory(current.dir);
  if (!entries) return { children: [] };

  if (await isRunRoot(current.dir, entries)) return { run: current.dir, children: [] };

  const children: Array<{ dir: string; depth: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    children.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
  }
  return { children };
}

async function readDirectory(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw error;
  }
}

async function isRunRoot(dir: string, entries: Dirent<string>[]): Promise<boolean> {
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has("manifest.json") && names.has("status.json")) return true;
  if (names.has("status.json") && names.has("events.jsonl")) return true;
  if (!names.has("artifacts")) return false;
  if (names.has("dispatch.lock") || names.has("children") || names.has("run.pid") || names.has("caffeinate.pid")) return true;
  return await fileExists(join(dir, "artifacts", "status.json"));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
