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
  reserveFloorPercentage?: number;
  activeCapacityPollIntervalMs?: number;
  requireRearmOnCapacityExhaustion?: boolean;
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
  observedAt?: string;
  observedRemainingPercentage?: number;
  reservedHeadroomPercentage?: number;
  reservedTokens?: number;
  unresolved: boolean;
};

export type CodexCircuitReason = "capacity" | "authentication" | "transient";
export type CodexCircuit = {
  reason: CodexCircuitReason;
  openedAt: string;
  fingerprint?: string;
  failures?: number;
};

export type CodexRoutingState = {
  roundRobin: number;
  next?: { profile: string; remaining: number };
  reservations: Record<string, ProfileReservation>;
  ledgers: Record<string, ProfileLedger>;
  circuits: Record<string, CodexCircuit>;
  unavailableProfiles: Record<string, string>;
};

type RegistryFile = { version: 1; profiles: CodexProfile[] };
type StateFile = { version: 2; state: CodexRoutingState };

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
  const empty = emptyRoutingState();
  const file = await readJson<{ version?: number; state?: Partial<CodexRoutingState> }>(
    store.stateFile,
    { version: 2, state: empty },
  );
  return migrateRoutingState(file.state, file.version);
}

export async function updateCodexRoutingState<T>(
  update: (state: CodexRoutingState) => T | Promise<T>,
  store = codexProfileStore(),
): Promise<T> {
  return withProfileLock(store, async () => {
    const state = await readCodexRoutingState(store);
    const result = await update(state);
    await atomicOwnerWrite(store.stateFile, { version: 2, state });
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
  observedAt?: string;
  observedRemainingPercentage?: number;
  reservedHeadroomPercentage?: number;
} = {}): ProfileReservation {
  return {
    id: randomUUID(),
    profile,
    startedAt: new Date().toISOString(),
    startingPercentage: options.startingPercentage,
    percentageQuantum: options.percentageQuantum,
    observedAt: options.observedAt,
    observedRemainingPercentage: options.observedRemainingPercentage,
    reservedHeadroomPercentage: options.reservedHeadroomPercentage,
    reservedTokens: options.reservedTokens,
    unresolved: true,
  };
}

function emptyRoutingState(): CodexRoutingState {
  return {
    roundRobin: 0,
    reservations: {},
    ledgers: {},
    circuits: {},
    unavailableProfiles: {},
  };
}

function migrateRoutingState(
  state: Partial<CodexRoutingState> | undefined,
  version: number | undefined,
): CodexRoutingState {
  const migrated: CodexRoutingState = {
    ...emptyRoutingState(),
    ...state,
    reservations: state?.reservations ?? {},
    ledgers: state?.ledgers ?? {},
    circuits: state?.circuits ?? {},
    unavailableProfiles: state?.unavailableProfiles ?? {},
  };
  if (version !== 2) {
    for (const reservation of Object.values(migrated.reservations)) {
      if (reservation.observedAt || reservation.reservedTokens !== undefined) continue;
      migrated.unavailableProfiles[reservation.profile] = "legacy active reservation lacks admission evidence";
    }
  }
  return migrated;
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
    if (!profile.home?.trim()) throw new Error(`invalid profile home: ${profile.name}`);
    if (profile.percentageQuantum !== undefined && profile.percentageQuantum <= 0) {
      throw new Error(`invalid percentage quantum: ${profile.name}`);
    }
    if (profile.reserveFloorPercentage !== undefined
      && (profile.reserveFloorPercentage < 0 || profile.reserveFloorPercentage > 100)) {
      throw new Error(`invalid reserve floor: ${profile.name}`);
    }
    if (profile.activeCapacityPollIntervalMs !== undefined
      && profile.activeCapacityPollIntervalMs <= 0) {
      throw new Error(`invalid active capacity poll interval: ${profile.name}`);
    }
    names.add(profile.name);
  }
}
