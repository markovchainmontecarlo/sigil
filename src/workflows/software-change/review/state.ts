import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SigilContext } from "../../../context.js";
import { acquireFileLock } from "../../../file-lock.js";
import type { DispatchOperationType } from "../../dispatch/state.js";

type ReviewOperationRecord = {
  id: string;
  type: DispatchOperationType;
  status: "running" | "completed" | "failed";
  inputArtifact: string;
  outputArtifact?: string;
};

type ReviewOperationState = { operations: ReviewOperationRecord[] };

export async function runReviewOperation<T>(
  ctx: SigilContext,
  type: DispatchOperationType,
  name: string,
  input: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const inputArtifact = await ctx.artifacts.write(
    `review/${name}-input.json`,
    `${JSON.stringify(input, null, 2)}\n`,
  );
  const record: ReviewOperationRecord = {
    id: randomUUID(),
    type,
    status: "running",
    inputArtifact,
  };
  await appendRecord(ctx, record);

  try {
    const result = await operation();
    const outputArtifact = await ctx.artifacts.write(
      `review/${name}-output.json`,
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await updateRecord(ctx, record.id, { status: "completed", outputArtifact });
    return result;
  } catch (error) {
    await updateRecord(ctx, record.id, { status: "failed" });
    throw error;
  }
}

async function appendRecord(
  ctx: SigilContext,
  record: ReviewOperationRecord,
): Promise<void> {
  await using _lock = await reviewStateLock(ctx);
  const state = await readState(ctx);
  state.operations.push(record);
  await writeState(ctx, state);
}

async function updateRecord(
  ctx: SigilContext,
  id: string,
  update: Partial<ReviewOperationRecord>,
): Promise<void> {
  await using _lock = await reviewStateLock(ctx);
  const state = await readState(ctx);
  const record = state.operations.find((operation) => operation.id === id);
  if (!record) throw new Error(`missing review operation: ${id}`);
  Object.assign(record, update);
  await writeState(ctx, state);
}

function reviewStateLock(ctx: SigilContext): Promise<AsyncDisposable> {
  return acquireFileLock(`${ctx.artifacts.path("review/operations.json")}.lock`);
}

async function readState(ctx: SigilContext): Promise<ReviewOperationState> {
  try {
    return JSON.parse(await readFile(ctx.artifacts.path("review/operations.json"), "utf8")) as ReviewOperationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { operations: [] };
    throw error;
  }
}

async function writeState(ctx: SigilContext, state: ReviewOperationState): Promise<void> {
  await ctx.artifacts.write(
    "review/operations.json",
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
