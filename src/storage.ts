import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RunPersistence = "durable" | "ephemeral";

export type DurablePath = {
  label: string;
  path: string;
};

const TEMPORARY_ROOTS = [tmpdir(), "/tmp", "/private/tmp"];

export function assertDurablePaths(paths: DurablePath[]): void {
  for (const entry of paths) assertDurablePath(entry);
}

export function assertDurablePath(entry: DurablePath): void {
  if (!isTemporaryPath(entry.path)) return;

  throw new Error(
    `durable run refused: ${entry.label} is under temporary storage (${resolve(entry.path)}); `
      + "move it to the repository, ~/.sigil/runs, or ~/.sigil/workspaces, or select ephemeral persistence",
  );
}

export function isTemporaryPath(path: string): boolean {
  const candidate = canonicalPath(path);
  return TEMPORARY_ROOTS.some((root) => isWithin(canonicalPath(root), candidate));
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;

  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }

  const canonicalExisting = existsSync(existing) ? realpathSync(existing) : existing;
  return join(canonicalExisting, ...missing);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
