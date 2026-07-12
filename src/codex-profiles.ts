import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { acquireFileLock } from "./file-lock.js";

export type CodexProfileClass = "subscription" | "metered-api";
export type MeteredMode = "manual" | "overflow" | "automatic";

export type MeteredBudget = {
  tokenLimit?: number;
  startLimit?: number;
  concurrencyLimit?: number;
  runtimeLimitMs?: number;
  requireRearm?: boolean;
  reservationTokens?: number;
};

export type CodexProfile = {
  name: string;
  home: string;
  enabled: boolean;
  profileClass: CodexProfileClass;
  concurrencyLimit?: number;
  percentageQuantum?: number;
  meteredMode?: MeteredMode;
  budget?: MeteredBudget;
};

export type CodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type ProfileLedger = {
  starts: number;
  active: number;
  reservedTokens: number;
  runtimeMs: number;
  usage: CodexUsage;
  rearmRequired: boolean;
};

export type ProfileReservation = {
  id: string;
  profile: string;
  startedAt: string;
  startingPercentage?: number;
  percentageQuantum?: number;
  reservedTokens?: number;
  unresolved: boolean;
};

export type CodexRoutingState = {
  roundRobin: number;
  next?: { profile: string; remaining: number };
  reservations: Record<string, ProfileReservation>;
  ledgers: Record<string, ProfileLedger>;
};

type RegistryFile = { version: 1; profiles: CodexProfile[] };
type StateFile = { version: 1; state: CodexRoutingState };

export type CodexProfileStore = {
  registryFile: string;
  stateFile: string;
  lockDir: string;
};

const EMPTY_USAGE: CodexUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export function codexProfileStore(sigilHome = process.env.SIGIL_HOME): CodexProfileStore {
  const root = resolve(sigilHome ?? join(homedir(), ".sigil"), "codex-profiles");
  return {
    registryFile: join(root, "registry.json"),
    stateFile: join(root, "routing-state.json"),
    lockDir: join(root, ".lock"),
  };
}

export async function readCodexProfiles(store = codexProfileStore()): Promise<CodexProfile[]> {
  return (await readJson<RegistryFile>(store.registryFile, { version: 1, profiles: [] })).profiles;
}

export async function writeCodexProfiles(
  profiles: CodexProfile[],
  store = codexProfileStore(),
): Promise<void> {
  validateProfiles(profiles);
  await atomicOwnerWrite(store.registryFile, { version: 1, profiles });
}

export async function updateCodexProfiles<T>(
  update: (profiles: CodexProfile[]) => T | Promise<T>,
  store = codexProfileStore(),
): Promise<T> {
  return withProfileLock(store, async () => {
    const profiles = await readCodexProfiles(store);
    const result = await update(profiles);
    await writeCodexProfiles(profiles, store);
    return result;
  });
}

export async function readCodexRoutingState(
  store = codexProfileStore(),
): Promise<CodexRoutingState> {
  const empty: StateFile = {
    version: 1,
    state: { roundRobin: 0, reservations: {}, ledgers: {} },
  };
  return (await readJson(store.stateFile, empty)).state;
}

export async function updateCodexRoutingState<T>(
  update: (state: CodexRoutingState) => T | Promise<T>,
  store = codexProfileStore(),
): Promise<T> {
  return withProfileLock(store, async () => {
    const state = await readCodexRoutingState(store);
    const result = await update(state);
    await atomicOwnerWrite(store.stateFile, { version: 1, state });
    return result;
  });
}

export function profileLedger(state: CodexRoutingState, name: string): ProfileLedger {
  state.ledgers[name] ??= {
    starts: 0,
    active: 0,
    reservedTokens: 0,
    runtimeMs: 0,
    usage: { ...EMPTY_USAGE },
    rearmRequired: false,
  };
  state.ledgers[name].reservedTokens ??= 0;
  return state.ledgers[name];
}

export function newReservation(profile: string, options: {
  startingPercentage?: number;
  percentageQuantum?: number;
  reservedTokens?: number;
} = {}): ProfileReservation {
  return {
    id: randomUUID(),
    profile,
    startedAt: new Date().toISOString(),
    startingPercentage: options.startingPercentage,
    percentageQuantum: options.percentageQuantum,
    reservedTokens: options.reservedTokens,
    unresolved: true,
  };
}

async function withProfileLock<T>(store: CodexProfileStore, body: () => Promise<T>): Promise<T> {
  await using _lock = await acquireFileLock(store.lockDir);
  return body();
}

async function atomicOwnerWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

function validateProfiles(profiles: CodexProfile[]): void {
  const names = new Set<string>();
  for (const profile of profiles) {
    if (!/^[a-zA-Z0-9._-]+$/.test(profile.name)) throw new Error(`invalid profile name: ${profile.name}`);
    if (names.has(profile.name)) throw new Error(`duplicate profile name: ${profile.name}`);
    if (!resolve(profile.home)) throw new Error(`invalid profile home: ${profile.name}`);
    names.add(profile.name);
  }
}
