import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireFileLock } from "../file-lock.js";
import { processIdentityIsAlive } from "../process-identity.js";

export type ProcessLease = {
  pid: number;
  startIdentity: string;
  heartbeat: string;
};

export async function acquireRunLock(path: string): Promise<AsyncDisposable> {
  return acquireFileLock(path, { timeoutMs: 2_000, staleAfterMs: 30_000 });
}

export async function writeProcessLease(path: string, lease: ProcessLease): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function removeProcessLease(path: string, lease: ProcessLease): Promise<void> {
  const current = await readProcessLease(path);
  if (!current) return;
  if (current.pid !== lease.pid || current.startIdentity !== lease.startIdentity) return;
  await rm(path, { force: true });
}

export async function assertNoLiveChild(path: string): Promise<void> {
  const lease = await readProcessLease(path);
  if (!lease) return;
  if (await processIdentityIsAlive(lease)) {
    throw new Error(`recorded child process ${lease.pid} may still own the worktree`);
  }
  await rm(path, { force: true });
}

export async function assertNoLiveChildren(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) await assertNoLiveChild(join(directory, name));
}

async function readProcessLease(path: string): Promise<ProcessLease | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProcessLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
