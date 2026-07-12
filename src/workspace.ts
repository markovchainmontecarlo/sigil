import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SigilConfig } from "./config.js";
import type { SigilContext } from "./context.js";
import { acquireFileLock } from "./file-lock.js";
import { isCleanTree } from "./git.js";

export async function bootstrapWorkspace(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
): Promise<void> {
  const command = config.workspace.bootstrap;
  if (!command) return;

  await using _lock = await acquireFileLock(
    await workspaceLockPath(repo),
    { timeoutMs: config.implement.operationTimeoutMs },
  );

  if (await workspaceReady(ctx, config.workspace.ready)) {
    await requireCleanWorkspace(repo);
    return;
  }

  await ctx.observe("workspace-bootstrap-started", { command });
  const result = await ctx.sh(command);
  await ctx.observe("workspace-bootstrap-completed", {
    command,
    exitCode: result.exitCode === null ? "unknown" : String(result.exitCode),
  });

  if (!result.ok) {
    const log = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`workspace bootstrap failed: ${log || result.message}`);
  }

  await requireCleanWorkspace(repo);
}

async function workspaceReady(
  ctx: SigilContext,
  command: string | undefined,
): Promise<boolean> {
  if (!command) return false;
  return (await ctx.sh(command)).ok;
}

async function requireCleanWorkspace(repo: string): Promise<void> {
  if (await isCleanTree(repo)) return;
  throw new Error("workspace bootstrap changed tracked repository files");
}

async function workspaceLockPath(repo: string): Promise<string> {
  const identity = createHash("sha256")
    .update(await realpath(repo))
    .digest("hex");
  return join(tmpdir(), "sigil-workspace-locks", `${identity}.lock`);
}
