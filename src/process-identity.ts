import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessIdentity = {
  pid: number;
  startIdentity: string;
};

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

export async function processIdentityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  try {
    const observed = await readProcessIdentity(identity.pid);
    return observed.startIdentity === identity.startIdentity;
  } catch {
    return false;
  }
}
