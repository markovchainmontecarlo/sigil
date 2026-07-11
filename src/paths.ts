import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Durable directory outside the target working tree where pipeline artifacts live
 * (the task graph, plan working files, review findings). Keyed by the repo's
 * resolved path so repeated runs against the same repo agree on a location
 * without threading it, and no artifact ever lands in the tree that
 * `implement` requires to be clean.
 */
export function artifactDir(repo: string): string {
  const key = createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
  return join(homedir(), ".sigil", "runs", "repositories", key);
}
