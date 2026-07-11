import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DispatchActiveItem = {
  id: string;
  branch: string;
  taskFile: string;
  stage: "software-change" | "repair" | "publish" | "merge" | "verify-base";
  issues: string[];
  prBody?: string;
};

export type DispatchCheckpoint = {
  version: 1;
  backlogDigest: string;
  deliveryPolicy: string;
  deliveryBase: string;
  delivered: Array<{ id: string; commit?: string }>;
  active?: DispatchActiveItem;
};

export function dispatchBacklogDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function loadDispatchCheckpoint(
  path: string,
  expected: Pick<DispatchCheckpoint, "backlogDigest" | "deliveryPolicy" | "deliveryBase">,
): Promise<DispatchCheckpoint> {
  const existing = await readCheckpoint(path);
  if (!existing) return { version: 1, ...expected, delivered: [] };
  if (existing.backlogDigest !== expected.backlogDigest) throw new Error("dispatch checkpoint belongs to a different backlog");
  if (existing.deliveryPolicy !== expected.deliveryPolicy) throw new Error("dispatch checkpoint belongs to a different delivery policy");
  if (existing.deliveryBase !== expected.deliveryBase) throw new Error("dispatch checkpoint belongs to a different delivery base");
  return existing;
}

export async function writeDispatchCheckpoint(path: string, state: DispatchCheckpoint): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

async function readCheckpoint(path: string): Promise<DispatchCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DispatchCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
