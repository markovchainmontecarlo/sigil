import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type ArchiveState = {
  runIds: string[];
};

export type ArchiveStore = {
  list(): Promise<Set<string>>;
  set(runId: string, archived: boolean): Promise<void>;
};

export function createArchiveStore(file: string): ArchiveStore {
  let mutation = Promise.resolve();

  return {
    async list() {
      return new Set((await readArchiveState(file)).runIds);
    },
    async set(runId, archived) {
      mutation = mutation.then(async () => {
        const state = await readArchiveState(file);
        const runIds = new Set(state.runIds);
        if (archived) runIds.add(runId);
        else runIds.delete(runId);
        await writeArchiveState(file, { runIds: [...runIds].sort() });
      });
      await mutation;
    },
  };
}

async function readArchiveState(file: string): Promise<ArchiveState> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<ArchiveState>;
    return { runIds: Array.isArray(value.runIds) ? value.runIds.filter((id): id is string => typeof id === "string") : [] };
  } catch {
    return { runIds: [] };
  }
}

async function writeArchiveState(file: string, state: ArchiveState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
