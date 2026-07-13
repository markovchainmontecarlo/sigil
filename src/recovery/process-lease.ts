import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { acquireFileLock } from "../file-lock.js";
import {
  processGroupHasLiveMembers,
  processIdentityIsAlive,
  processIdentityStatus,
  type ProcessIdentity,
} from "../process-identity.js";
import { terminateProcessGroup } from "../process-group.js";
import type { OwnedProcessKind } from "../process-lifecycle.js";

export type ProcessLease = {
  pid: number;
  startIdentity: string;
  ownerIdentity: ProcessIdentity;
  childKind: OwnedProcessKind;
  processGroupId: number;
};

type LegacyProcessLease = ProcessIdentity & {
  format: "legacy";
};

type StoredProcessLease = ProcessLease | LegacyProcessLease;

const processIdentitySchema = z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
});

const currentProcessLeaseSchema = processIdentitySchema.extend({
  ownerIdentity: processIdentitySchema,
  childKind: z.enum(["acp", "codex-app-server", "pty", "shell", "gate"]),
  processGroupId: z.number().int().positive(),
});

const legacyProcessLeaseSchema = processIdentitySchema.extend({
  heartbeat: z.unknown().optional(),
});

const TERMINATION_GRACE_MS = 500;
const KILL_GRACE_MS = 2_000;

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
  if ("format" in current) return;
  if (!sameLeaseIdentity(current, lease)) return;
  await rm(path, { force: true });
}

function sameLeaseIdentity(left: ProcessLease, right: ProcessLease): boolean {
  return left.pid === right.pid
    && left.startIdentity === right.startIdentity
    && left.processGroupId === right.processGroupId
    && left.ownerIdentity.pid === right.ownerIdentity.pid
    && left.ownerIdentity.startIdentity === right.ownerIdentity.startIdentity;
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

export async function reconcileProcessLeases(directory: string): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) await reconcileProcessLease(join(directory, name));
}

async function reconcileProcessLease(path: string): Promise<void> {
  const lease = await readProcessLease(path);
  if (!lease) return;
  if ("format" in lease) {
    await reconcileLegacyProcessLease(path, lease);
    return;
  }
  if (await processIdentityIsAlive(lease.ownerIdentity)) {
    throw new Error(`recorded dispatcher owner ${lease.ownerIdentity.pid} is still alive`);
  }

  const leaderStatus = await processIdentityStatus(lease);
  if (leaderStatus === "reused") {
    if (!(await processGroupHasLiveMembers(lease.processGroupId))) {
      await removeProcessLease(path, lease);
      return;
    }
    throw new Error(
      `abandoned process group ${lease.processGroupId} has a reused leader and cannot be signalled safely`,
    );
  }

  if (!(await processGroupHasLiveMembers(lease.processGroupId))) {
    await removeProcessLease(path, lease);
    return;
  }

  await terminateProcessGroup({
    identity: lease,
    processGroupId: lease.processGroupId,
    terminationGraceMs: TERMINATION_GRACE_MS,
    killGraceMs: KILL_GRACE_MS,
  });

  await removeProcessLease(path, lease);
}

async function reconcileLegacyProcessLease(
  path: string,
  lease: LegacyProcessLease,
): Promise<void> {
  const status = await processIdentityStatus(lease);
  if (status === "match") {
    throw new Error(
      `legacy child process ${lease.pid} is still alive and its ownership cannot be established`,
    );
  }
  await rm(path, { force: true });
}

async function readProcessLease(path: string): Promise<StoredProcessLease | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const current = currentProcessLeaseSchema.safeParse(value);
    if (current.success) return current.data;
    const legacy = legacyProcessLeaseSchema.safeParse(value);
    if (legacy.success) return { ...legacy.data, format: "legacy" };
    throw new Error(`invalid process lease ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
