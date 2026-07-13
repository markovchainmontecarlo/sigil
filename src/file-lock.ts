import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  processIdentityIsAlive,
  readProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.js";

export type FileLockOptions = {
  timeoutMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  recovery?: "default" | "strict";
};

type LockOwner = ProcessIdentity & { acquiredAt: string; token: string };

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_POLL_MS = 25;

export async function acquireFileLock(
  lockDir: string,
  options: FileLockOptions = {},
): Promise<AsyncDisposable> {
  const owner = await currentLockOwner();
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);

  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  while (!(await tryAcquire(lockDir, owner))) {
    await recoverStaleLock(
      lockDir,
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      options.recovery ?? "default",
    );
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock: ${lockDir}`);
    await sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }

  return {
    async [Symbol.asyncDispose]() {
      await releaseOwnedLock(lockDir, owner);
    },
  };
}

async function currentLockOwner(): Promise<LockOwner> {
  return {
    ...await readProcessIdentity(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

async function tryAcquire(lockDir: string, owner: LockOwner): Promise<boolean> {
  try {
    await mkdir(lockDir, { mode: 0o700 });
    const temporary = join(lockDir, "owner.tmp");
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await rename(temporary, join(lockDir, "owner.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    await rm(lockDir, { recursive: true, force: true });
    throw error;
  }
}

async function recoverStaleLock(
  lockDir: string,
  staleAfterMs: number,
  recovery: "default" | "strict",
): Promise<void> {
  const owner = await readLockOwner(lockDir);
  if (!owner) {
    const age = await lockAge(lockDir);
    if (recovery === "strict" && age >= staleAfterMs) {
      throw new Error(`lock owner is unverifiable: ${lockDir}`);
    }
    if (age >= staleAfterMs) await rm(lockDir, { recursive: true, force: true });
    return;
  }

  try {
    const alive = await processIdentityIsAlive(owner);
    if (!alive) await rm(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (recovery === "strict") throw new Error(`lock owner is unverifiable: ${lockDir}`, { cause: error });
  }
}

async function lockAge(lockDir: string): Promise<number> {
  try {
    const details = await stat(lockDir);
    return Date.now() - details.mtimeMs;
  } catch {
    return 0;
  }
}

async function readLockOwner(lockDir: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function releaseOwnedLock(lockDir: string, owner: LockOwner): Promise<void> {
  const current = await readLockOwner(lockDir);
  if (!current) return;
  if (current.token !== owner.token) return;
  await rm(lockDir, { recursive: true, force: true });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
