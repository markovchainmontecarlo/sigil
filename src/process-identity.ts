import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessIdentity = {
  pid: number;
  startIdentity: string;
};

export type ProcessIdentityStatus = "match" | "missing" | "reused";

export async function readProcessIdentity(pid = process.pid): Promise<ProcessIdentity> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-p", String(pid), "-o", "lstart="],
    { encoding: "utf8" },
  );
  const startIdentity = stdout.trim();
  if (!startIdentity) throw new Error(`process ${pid} is not running`);
  return { pid, startIdentity };
}

export async function readProcessGroupId(pid: number): Promise<number> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-p", String(pid), "-o", "pgid="],
    { encoding: "utf8" },
  );
  const processGroupId = Number(stdout.trim());
  if (!processGroupId) throw new Error(`process group for ${pid} is not available`);
  return processGroupId;
}

export async function processIdentityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  return await processIdentityStatus(identity) === "match";
}

export async function processIdentityStatus(
  identity: ProcessIdentity,
): Promise<ProcessIdentityStatus> {
  try {
    const observed = await readProcessIdentity(identity.pid);
    return observed.startIdentity === identity.startIdentity ? "match" : "reused";
  } catch (error) {
    if ((error as { code?: string | number }).code === 1) return "missing";
    throw error;
  }
}

export function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(process.platform === "win32" ? processGroupId : -processGroupId, signal);
    return true;
  } catch {
    return false;
  }
}

export function processGroupIsAlive(processGroupId: number): boolean {
  return signalProcessGroup(processGroupId, 0);
}

export async function processGroupHasLiveMembers(processGroupId: number): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-ax", "-o", "pgid=,stat="],
    { encoding: "utf8" },
  );
  return stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/, 2);
    return Number(group) === processGroupId && !state?.startsWith("Z");
  });
}
