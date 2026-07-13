import {
  processGroupHasLiveMembers,
  processIdentityStatus,
  signalProcessGroup,
  type ProcessIdentity,
} from "./process-identity.js";

export type TerminateProcessGroupOptions = {
  identity: ProcessIdentity;
  processGroupId: number;
  terminationGraceMs: number;
  killGraceMs: number;
};

const GROUP_POLL_MS = 20;

export async function terminateProcessGroup(
  options: TerminateProcessGroupOptions,
): Promise<void> {
  const status = await processIdentityStatus(options.identity);
  const hasMembers = await processGroupHasLiveMembers(options.processGroupId);
  if (!hasMembers) return;
  if (status === "reused") {
    throw new Error(
      `process group ${options.processGroupId} has a reused leader and cannot be signalled safely`,
    );
  }

  signalProcessGroup(options.processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(options.processGroupId, options.terminationGraceMs)) return;

  signalProcessGroup(options.processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(options.processGroupId, options.killGraceMs)) return;

  throw new Error(`process group ${options.processGroupId} did not exit`);
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
