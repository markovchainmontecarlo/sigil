import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { git } from "../../../git.js";
import { orderedTasks, type TaskGraph } from "../../../contracts/task-graph.js";

export type ImplementationTaskStatus = "pending" | "running" | "completed" | "failed" | "blocked";
export type ImplementationTaskState = {
  status: ImplementationTaskStatus;
  attempts: number;
  evidence?: string;
  verifiedCommit?: string;
  taskBase?: string;
  recoveryBundle?: string;
};
export type ImplementationCheckpoint = {
  version: 1;
  graphDigest: string;
  branch: string;
  baseBranch: string;
  baselineCommit: string;
  tasks: Record<string, ImplementationTaskState>;
};
export type RecoveryBundle = {
  version: 1;
  graphDigest: string;
  branch: string;
  baseBranch: string;
  baselineCommit: string;
  taskId: string;
  taskBase: string;
  head: string;
  patchFile: string;
  untrackedFile: string;
  contentDigest: string;
};

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function readCheckpoint(path: string): Promise<ImplementationCheckpoint> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as ImplementationCheckpoint;
  if (parsed.version !== 1 || !parsed.graphDigest || !parsed.branch || !parsed.baseBranch || !parsed.baselineCommit || !parsed.tasks) {
    throw new Error("implementation checkpoint is missing required identity");
  }
  return parsed;
}

export function newCheckpoint(graph: TaskGraph, graphDigest: string, branch: string, baseBranch: string, baselineCommit: string): ImplementationCheckpoint {
  return {
    version: 1, graphDigest, branch, baseBranch, baselineCommit,
    tasks: Object.fromEntries(orderedTasks(graph.tasks).map((task) => [task.id, { status: "pending", attempts: 0 }])),
  };
}

export function reevaluateBlocked(graph: TaskGraph, checkpoint: ImplementationCheckpoint): void {
  for (const task of orderedTasks(graph.tasks)) {
    const state = checkpoint.tasks[task.id];
    if (state.status === "completed" || state.status === "failed" || state.status === "running") continue;
    state.status = task.dependencies.every((dependency) => checkpoint.tasks[dependency]?.status === "completed") ? "pending" : "blocked";
  }
}

export function nextRunnable(graph: TaskGraph, checkpoint: ImplementationCheckpoint): string | undefined {
  reevaluateBlocked(graph, checkpoint);
  return orderedTasks(graph.tasks).find((task) => checkpoint.tasks[task.id].status === "pending")?.id;
}

export async function verifyCompletedTasks(repo: string, checkpoint: ImplementationCheckpoint): Promise<void> {
  for (const [task, state] of Object.entries(checkpoint.tasks)) {
    if (state.status !== "completed") continue;
    if (!state.verifiedCommit) throw new Error(`completed task ${task} has no verified commit`);
    const exists = await git(repo, ["cat-file", "-e", `${state.verifiedCommit}^{commit}`]);
    const ancestor = await git(repo, ["merge-base", "--is-ancestor", state.verifiedCommit, "HEAD"]);
    if (exists.code !== 0 || ancestor.code !== 0) throw new Error(`completed task ${task} commit is not present in HEAD ancestry`);
  }
}

const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
type UntrackedArchive = Array<{ path: string; data: string; digest: string }>;

export async function captureRecoveryBundle(
  repo: string,
  bundleDir: string,
  identity: Omit<RecoveryBundle, "version" | "patchFile" | "untrackedFile" | "contentDigest" | "head">,
): Promise<string> {
  await mkdir(bundleDir, { recursive: true });
  const patch = (await git(repo, ["diff", "--binary", identity.taskBase, "--"])).stdout;
  const listed = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean).sort();
  const archive: UntrackedArchive = [];
  let bytes = 0;
  for (const path of listed) {
    const data = await readFile(join(repo, path));
    bytes += data.byteLength;
    if (bytes > MAX_UNTRACKED_BYTES) throw new Error("recovery bundle untracked content exceeds 10 MiB");
    archive.push({ path, data: data.toString("base64"), digest: digest(data) });
  }
  const patchFile = join(bundleDir, "tracked.patch");
  const untrackedFile = join(bundleDir, "untracked.json");
  await writeFile(patchFile, patch, "utf8");
  await writeFile(untrackedFile, JSON.stringify(archive), "utf8");
  const metadata: RecoveryBundle = {
    version: 1, ...identity, head: (await git(repo, ["rev-parse", "HEAD"])).stdout.trim(),
    patchFile, untrackedFile, contentDigest: digest(Buffer.from(`${patch}\0${JSON.stringify(archive)}`)),
  };
  const metadataFile = join(bundleDir, "bundle.json");
  await writeAtomicJson(metadataFile, metadata);
  return metadataFile;
}

export async function restoreRecoveryBundle(repo: string, metadataFile: string, expected: Omit<RecoveryBundle, "version" | "patchFile" | "untrackedFile" | "contentDigest" | "head">): Promise<void> {
  const bundle = JSON.parse(await readFile(metadataFile, "utf8")) as RecoveryBundle;
  const fields: Array<keyof typeof expected> = ["graphDigest", "branch", "baseBranch", "baselineCommit", "taskId", "taskBase"];
  if (bundle.version !== 1 || fields.some((field) => bundle[field] !== expected[field])) throw new Error("recovery bundle identity does not match implementation checkpoint");
  const branch = (await git(repo, ["branch", "--show-current"])).stdout.trim();
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const ancestor = await git(repo, ["merge-base", "--is-ancestor", bundle.baselineCommit, head]);
  if (branch !== bundle.branch || head !== bundle.taskBase || ancestor.code !== 0 || bundle.head !== bundle.taskBase) {
    throw new Error("recovery bundle Git identity does not match the current worktree");
  }
  const patch = await readFile(bundle.patchFile, "utf8");
  const archive = JSON.parse(await readFile(bundle.untrackedFile, "utf8")) as UntrackedArchive;
  if (digest(Buffer.from(`${patch}\0${JSON.stringify(archive)}`)) !== bundle.contentDigest
    || archive.some((entry) => !containedPath(repo, entry.path) || digest(Buffer.from(entry.data, "base64")) !== entry.digest)) {
    throw new Error("recovery bundle content digest mismatch");
  }
  if ((await git(repo, ["status", "--porcelain=v1"])).stdout.trim()) throw new Error("recovery bundle restore requires a clean worktree");
  if (patch && (await git(repo, ["apply", "--binary", "--whitespace=nowarn", bundle.patchFile])).code !== 0) throw new Error("recovery bundle tracked patch could not be applied");
  try {
    for (const entry of archive) {
      const target = join(repo, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(entry.data, "base64"));
    }
  } catch (error) {
    await git(repo, ["reset", "--hard", bundle.taskBase]);
    await git(repo, ["clean", "-fd"]);
    throw error;
  }
}

export async function discardTaskWork(repo: string, taskBase: string): Promise<void> {
  await git(repo, ["reset", "--hard", taskBase]);
  await git(repo, ["clean", "-fd"]);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function containedPath(repo: string, path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const rel = relative(resolve(repo), resolve(repo, path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
