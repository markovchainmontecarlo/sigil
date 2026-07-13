import { join, resolve } from "node:path";

import { createContext } from "../context.js";
import { assertDurablePaths } from "../storage.js";
import {
  dispatch,
  type DeliveryPolicy,
  type DispatchInput,
} from "../workflows/dispatch/index.js";
import { breakdown } from "../workflows/breakdown/index.js";
import { migrate } from "../workflows/migrate/index.js";
import { probePlan } from "../workflows/probe/index.js";
import { refactor } from "../workflows/refactor/index.js";
import { UsageError } from "./errors.js";
import { readOptionalFile } from "./input.js";
import { printJson } from "./output.js";
import { parseCommandArgs, rejectPositionals, repeatedValues, requireValue, value } from "./parse.js";
import { writeDispatchRuntime } from "../workflows/dispatch/state.js";
import { acquireRunLock, removeProcessLease, writeProcessLease } from "../recovery/process-lease.js";
import { reconcileDispatchResume } from "../workflows/dispatch/reconciliation.js";
import type { OwnedProcessInfo, ProcessLifecycle } from "../owned-process.js";

function deliveryPolicy(raw: string | undefined): DeliveryPolicy {
  if (raw === "mergeWhenGreen" || raw === "integrationBranch") return raw;
  throw new UsageError(`invalid --policy: ${raw}`);
}

function dispatchInput(
  repo: string,
  backlogFile: string,
  rawPolicy: string | undefined,
  integrationBranch: string | undefined,
  finalAction: string | undefined,
  productionGate: string | undefined,
): DispatchInput {
  const policy = deliveryPolicy(rawPolicy);
  if (policy === "mergeWhenGreen") {
    return { repo, backlogFile, deliveryPolicy: policy };
  }
  if (!integrationBranch) {
    throw new UsageError("missing required --integration-branch");
  }
  if (finalAction !== undefined && finalAction !== "openPullRequest" && finalAction !== "mergeWhenGreen") {
    throw new UsageError(`invalid --final-action: ${finalAction}`);
  }
  return {
    repo,
    backlogFile,
    deliveryPolicy: policy,
    integrationBranch,
    finalAction: finalAction ?? "openPullRequest",
    productionGate,
  };
}

export async function probeCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    intent: { type: "string" },
    brief: { type: "string" },
    out: { type: "string" },
    "max-probes": { type: "string" },
  });
  rejectPositionals(parsed);

  const maxProbesRaw = value(parsed, "max-probes");
  const maxProbes = maxProbesRaw === undefined ? undefined : Number.parseInt(maxProbesRaw, 10);
  if (maxProbes !== undefined && (!Number.isFinite(maxProbes) || maxProbes < 1)) throw new UsageError(`invalid --max-probes: ${maxProbesRaw}`);

  const result = await probePlan({
    repo: requireValue(parsed, "repo"),
    intent: requireValue(parsed, "intent"),
    brief: await readOptionalFile(value(parsed, "brief")),
    outFile: value(parsed, "out"),
    maxProbes,
  });
  printJson(result);
  return result.valid ? 0 : 1;
}

export async function refactorCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    intent: { type: "string" },
    brief: { type: "string" },
    focus: { type: "string", multiple: true },
    "protected-path": { type: "string", multiple: true },
  });
  rejectPositionals(parsed);

  const result = await refactor({
    repo: requireValue(parsed, "repo"),
    intent: requireValue(parsed, "intent"),
    brief: await readOptionalFile(value(parsed, "brief")),
    focus: repeatedValues(parsed, "focus"),
    protectedPaths: repeatedValues(parsed, "protected-path"),
  });
  printJson(result);
  return result.valid ? 0 : 1;
}

export async function migrateCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    target: { type: "string" },
    backlog: { type: "string" },
    "run-dir": { type: "string" },
  });
  rejectPositionals(parsed);

  const repo = requireValue(parsed, "repo");
  const targetFile = requireValue(parsed, "target");
  const backlogFile = requireValue(parsed, "backlog");
  const runDir = requireValue(parsed, "run-dir");
  if (!durableMigrationStorage(repo, targetFile, backlogFile, runDir)) return 1;
  const result = await migrate({
    repo,
    targetFile,
    backlogFile,
    runDir,
  }, createContext(repo, { artifactRoot: join(runDir, "runtime") }));
  printJson(result);
  return result.valid ? 0 : 1;
}

function durableMigrationStorage(
  repo: string,
  targetFile: string,
  backlogFile: string,
  runDir: string,
): boolean {
  try {
    assertDurablePaths([
      { label: "target repository", path: repo },
      { label: "migration target", path: targetFile },
      { label: "migration backlog", path: backlogFile },
      { label: "migration run directory", path: runDir },
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return false;
  }
}

export async function breakdownCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    mission: { type: "string" },
    out: { type: "string" },
  });
  rejectPositionals(parsed);

  const result = await breakdown({
    mission: requireValue(parsed, "mission"),
    repo: requireValue(parsed, "repo"),
    outFile: value(parsed, "out"),
  });
  printJson(result);
  return result.valid ? 0 : 1;
}

export async function dispatchCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
    backlog: { type: "string" },
    policy: { type: "string" },
    "integration-branch": { type: "string" },
    "final-action": { type: "string" },
    "production-gate": { type: "string" },
    "run-dir": { type: "string" },
    resume: { type: "string" },
  });
  rejectPositionals(parsed);

  const resumeDir = value(parsed, "resume");
  const runDir = resolve(resumeDir ?? requireValue(parsed, "run-dir"));
  const resumeScope = resumeDir ? await reconcileDispatchResume(runDir) : undefined;
  await using _lock = resumeScope ?? await acquireRunLock(join(runDir, "dispatch.lock"));
  const resumed = resumeScope?.state;

  const input = dispatchInput(
    resumed?.repository ?? requireValue(parsed, "repo"),
    resumed?.backlogFile ?? requireValue(parsed, "backlog"),
    resumed?.deliveryPolicy ?? value(parsed, "policy"),
    value(parsed, "integration-branch") ?? (resumed?.deliveryPolicy === "integrationBranch" ? resumed.deliveryBase : undefined),
    value(parsed, "final-action"),
    value(parsed, "production-gate"),
  );
  const childLeaseDir = join(runDir, "children");
  const runtimeFile = join(runDir, "artifacts", "dispatch-runtime.json");
  const result = await dispatch(input, createContext(input.repo, {
    artifactRoot: join(runDir, "artifacts"),
    onAgentRuntime: async (runtime) => {
      await writeDispatchRuntime(runtimeFile, {
        version: 1,
        binding: runtime.binding,
        providerSessionId: runtime.providerSessionId,
        childProcessId: runtime.childProcessId,
        childStartIdentity: runtime.childStartIdentity,
        active: runtime.active ?? false,
      });
    },
    processLifecycle: dispatchProcessLifecycle(childLeaseDir),
  }));
  printJson(result);
  if (result.status === "waiting") return 75;
  return result.stoppedAt === undefined ? 0 : 1;
}

function dispatchProcessLifecycle(directory: string): ProcessLifecycle {
  return {
    started: (process) => writeProcessLease(
      processLeasePath(directory, process),
      processLease(process),
    ),
    stopped: (process) => removeProcessLease(
      processLeasePath(directory, process),
      processLease(process),
    ),
  };
}

function processLease(process: OwnedProcessInfo) {
  const lease = {
    pid: process.identity.pid,
    startIdentity: process.identity.startIdentity,
    ownerIdentity: process.ownerIdentity,
    childKind: process.kind,
    processGroupId: process.processGroupId,
  };
  return lease;
}

function processLeasePath(directory: string, process: OwnedProcessInfo): string {
  return join(directory, `${process.identity.pid}.json`);
}
