import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireFileLock } from "../../file-lock.js";
import type { AgentRuntimeMetadata } from "../../agents.js";

export type DispatchOperationType =
  | "planning"
  | "implementation/task"
  | "final-verification"
  | "review/panel"
  | "review/synthesis"
  | "review/test-integrity"
  | "review/repair"
  | "post-review-verification"
  | "publish"
  | "merge"
  | "verify-base"
  | "final-pull-request"
  | "final-merge"
  | "production-verification";

export type DispatchStageEvidence =
  | { kind: "remote-pr"; number?: number; head: string; base: string; headCommit?: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedCommit?: string; url?: string }
  | { kind: "merge"; head: string; base: string; headCommit?: string; mergedCommit?: string }
  | { kind: "verification"; commit: string; gateInput: string; log: string };

export type RepositoryExpectation = {
  branch: string;
  baseCommit?: string;
  expectedHead?: string;
  tree: "clean" | "dirty";
  recoveryRef?: string;
  diffDigest?: string;
};

export type DispatchOperation = {
  id: string;
  type: DispatchOperationType;
  status: "running" | "completed" | "failed" | "interrupted" | "capacity-blocked" | "recovering";
  attempt: number;
  repairBudget: number;
  inputArtifact: string;
  inputDigest: string;
  outputArtifact?: string;
  repository: RepositoryExpectation;
  repositoryAfter?: RepositoryExpectation;
  agent?: { binding: string; providerSessionId?: string };
  child?: { pid: number; startIdentity: string };
  lease?: { owner: string; heartbeat: string };
  gates: Record<string, { status: "passed" | "failed" | "skipped"; inputDigest: string; evidence?: string }>;
  failure?: {
    kind: "capacity" | "provider-interruption" | "reconciliation" | "deterministic";
    code?: string;
    fingerprint?: string;
    evidence: string;
  };
  implementation?: { canonicalGraphFile: string; graphDigest?: string; checkpointFile: string };
  evidence?: DispatchStageEvidence;
};

export type DispatchActiveItem = {
  id: string;
  branch: string;
  taskFile: string;
  canonicalGraphFile?: string;
  graphDigest?: string;
  implementationCheckpointFile?: string;
  stage: "software-change" | "repair" | "publish" | "merge" | "verify-base";
  issues: string[];
  prBody?: string;
};

export type DispatchCheckpoint = {
  version: 3;
  repository: string;
  backlogFile: string;
  backlogDigest: string;
  deliveryPolicy: string;
  deliveryBase: string;
  delivered: Array<{ id: string; commit?: string }>;
  active?: DispatchActiveItem;
  operation?: DispatchOperation;
  operations?: DispatchOperation[];
};

export type DispatchIdentity = Pick<
  DispatchCheckpoint,
  "repository" | "backlogFile" | "backlogDigest" | "deliveryPolicy" | "deliveryBase"
>;

export async function writeDispatchRuntime(
  path: string,
  runtime: AgentRuntimeMetadata,
): Promise<void> {
  await using _lock = await acquireFileLock(`${path}.lock`);
  await writeAtomic(path, runtime);
}

export async function readDispatchRuntime(path: string): Promise<AgentRuntimeMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentRuntimeMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function dispatchBacklogDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function dispatchValueDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function startDispatchOperation(input: {
  type: DispatchOperationType;
  inputArtifact: string;
  input: unknown;
  repository: RepositoryExpectation;
  repairBudget: number;
}): DispatchOperation {
  return {
    id: randomUUID(),
    type: input.type,
    status: "running",
    attempt: 1,
    repairBudget: input.repairBudget,
    inputArtifact: input.inputArtifact,
    inputDigest: dispatchValueDigest(input.input),
    repository: input.repository,
    gates: {},
  };
}

export async function loadDispatchCheckpoint(
  path: string,
  expected: DispatchIdentity,
): Promise<DispatchCheckpoint> {
  const existing = await readCheckpoint(path);
  if (!existing) return { version: 3, ...expected, delivered: [] };
  migrateDispatchCheckpoint(existing);
  assertDispatchIdentity(existing, expected);
  return existing;
}

export function migrateDispatchCheckpoint(existing: DispatchCheckpoint): void {
  existing.operations ??= [];
  if ((existing as { version: number }).version === 3) return;
  (existing as { version: number }).version = 3;
  if (!existing.active || !existing.operation || existing.operation.status === "completed") return;
  if (existing.operation.type === "implementation/task" && !existing.active.implementationCheckpointFile) {
    existing.operation.status = "interrupted";
    existing.operation.failure = {
      kind: "reconciliation",
      evidence: "active legacy implementation lacks canonical graph and task checkpoint identity",
    };
  }
}

export function assertDispatchIdentity(existing: DispatchCheckpoint, expected: DispatchIdentity): void {
  if (existing.repository !== expected.repository) throw new Error("dispatch run belongs to a different repository");
  if (existing.backlogFile !== expected.backlogFile) throw new Error("dispatch run belongs to a different backlog path");
  if (existing.backlogDigest !== expected.backlogDigest) throw new Error("dispatch run belongs to a different backlog");
  if (existing.deliveryPolicy !== expected.deliveryPolicy) throw new Error("dispatch run belongs to a different delivery policy");
  if (existing.deliveryBase !== expected.deliveryBase) throw new Error("dispatch run belongs to a different delivery base");
}

export async function writeDispatchCheckpoint(path: string, state: DispatchCheckpoint): Promise<void> {
  await writeAtomic(path, state);
}

export async function readDispatchCheckpoint(path: string): Promise<DispatchCheckpoint> {
  const state = await readCheckpoint(path);
  if (!state) throw new Error(`dispatch run manifest not found: ${path}`);
  migrateDispatchCheckpoint(state);
  return state;
}

async function readCheckpoint(path: string): Promise<DispatchCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DispatchCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
