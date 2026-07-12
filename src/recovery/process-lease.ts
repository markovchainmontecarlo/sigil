import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireFileLock } from "../file-lock.js";
import {
  processGroupHasLiveMembers,
  processIdentityIsAlive,
  processIdentityStatus,
  signalProcessGroup,
  type ProcessIdentity,
} from "../process-identity.js";
import type { OwnedProcessKind } from "../owned-process.js";

export type ProcessLease = {
  pid: number;
  startIdentity: string;
  ownerIdentity: ProcessIdentity;
  childKind: OwnedProcessKind;
  processGroupId: number;
};

const TERMINATION_GRACE_MS = 500;
const KILL_GRACE_MS = 2_000;
const GROUP_POLL_MS = 25;

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

  signalProcessGroup(lease.processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(lease.processGroupId, TERMINATION_GRACE_MS)) {
    await removeProcessLease(path, lease);
    return;
  }

  signalProcessGroup(lease.processGroupId, "SIGKILL");
  if (!(await waitForProcessGroupExit(lease.processGroupId, KILL_GRACE_MS))) {
    throw new Error(`abandoned process group ${lease.processGroupId} did not exit`);
  }

  await removeProcessLease(path, lease);
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupHasLiveMembers(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return !(await processGroupHasLiveMembers(processGroupId));
}

async function readProcessLease(path: string): Promise<ProcessLease | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProcessLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
