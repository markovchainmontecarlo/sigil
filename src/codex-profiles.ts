import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { acquireFileLock } from "./file-lock.js";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { ProcessIdentity } from "./process-identity.js";
import { ProcessOwnerSchema, ProfileStoreError } from "./provider-profiles.js";

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
  owner: ProcessIdentity;
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
type PersistedReservation = Omit<ProfileReservation, "owner"> & {
  owner?: ProcessIdentity;
};
type PersistedRoutingState = Omit<CodexRoutingState, "reservations"> & {
  reservations: Record<string, PersistedReservation>;
};

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
  const value = await readValidatedJson(store.registryFile, RegistryFileSchema, { version: 1, profiles: [] });
  validateProfiles(value.profiles);
  return value.profiles;
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
  const file = await readValidatedJson(store.stateFile, PersistedStateFileSchema, {
    version: 2,
    state: emptyRoutingState(),
  });
  const profiles = await readCodexProfiles(store);
  return migrateRoutingState(file.state, profiles);
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
  owner: ProcessIdentity;
  startingPercentage?: number;
  percentageQuantum?: number;
  reservedTokens?: number;
  observedAt?: string;
  observedRemainingPercentage?: number;
  reservedHeadroomPercentage?: number;
}): ProfileReservation {
  return {
    id: randomUUID(),
    profile,
    owner: options.owner,
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
  state: PersistedRoutingState,
  profiles: CodexProfile[],
): CodexRoutingState {
  const reservations: Record<string, ProfileReservation> = {};
  const legacyReservations: PersistedReservation[] = [];

  for (const reservation of Object.values(state.reservations)) {
    if (reservation.owner) reservations[reservation.id] = reservation as ProfileReservation;
    else legacyReservations.push(reservation);
  }

  reconcileLegacyReservations(state.ledgers, legacyReservations, profiles);
  normalizeRearmState(state.ledgers, profiles);
  return { ...state, reservations };
}

function reconcileLegacyReservations(
  ledgers: Record<string, ProfileLedger>,
  reservations: PersistedReservation[],
  profiles: CodexProfile[],
): void {
  for (const reservation of reservations) {
    const ledger = ledgers[reservation.profile];
    if (!ledger) continue;

    ledger.active = Math.max(0, ledger.active - 1);
    const reservedTokens = reservation.reservedTokens ?? 0;
    ledger.usage.inputTokens += reservedTokens;
    ledger.usage.totalTokens += reservedTokens;
    ledger.reservedTokens = Math.max(
      0,
      ledger.reservedTokens - reservedTokens,
    );
    if (profileRequiresRearm(profiles, reservation.profile)) {
      ledger.rearmRequired = true;
    }
  }
}

function normalizeRearmState(
  ledgers: Record<string, ProfileLedger>,
  profiles: CodexProfile[],
): void {
  for (const profile of profiles) {
    const ledger = ledgers[profile.name];
    if (ledger && !profileRequiresRearm(profiles, profile.name)) {
      ledger.rearmRequired = false;
    }
  }
}

function profileRequiresRearm(
  profiles: CodexProfile[],
  name: string,
): boolean {
  const profile = profiles.find((entry) => entry.name === name);
  if (profile?.profileClass === "subscription") {
    return profile.requireRearmOnCapacityExhaustion === true;
  }
  return profile?.budget?.requireRearm === true;
}

async function withProfileLock<T>(store: CodexProfileStore, body: () => Promise<T>): Promise<T> {
  await using _lock = await acquireFileLock(store.lockDir, { recovery: "strict" });
  return body();
}

async function atomicOwnerWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readValidatedJson<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    const details = await stat(path);
    if ((details.mode & 0o077) !== 0) throw new ProfileStoreError("unsafe-permissions", `unsafe permissions: ${path}`);
    const input = JSON.parse(await readFile(path, "utf8")) as unknown;
    const version = (input as { version?: unknown })?.version;
    if (typeof version === "number" && version !== (fallback as { version: number }).version) {
      throw new ProfileStoreError("unsupported-version", `unsupported profile file version: ${version}`);
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ProfileStoreError("corrupt", `invalid profile file: ${path}`);
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new ProfileStoreError("corrupt", `invalid JSON: ${path}`, { cause: error });
    throw error;
  }
}

const UsageSchema = z.object({ inputTokens: z.number().nonnegative(), cachedInputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), reasoningTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative() }).strict();
const LedgerSchema = z.object({ starts: z.number().int().nonnegative(), active: z.number().int().nonnegative(), reservedTokens: z.number().nonnegative(), runtimeMs: z.number().nonnegative(), usage: UsageSchema, rearmRequired: z.boolean() }).strict();
const ReservationFileSchema = z.object({ id: z.string().min(1), profile: z.string().min(1), owner: ProcessOwnerSchema.optional(), startedAt: z.string().datetime(), startingPercentage: z.number().optional(), percentageQuantum: z.number().optional(), observedAt: z.string().optional(), observedRemainingPercentage: z.number().optional(), reservedHeadroomPercentage: z.number().optional(), reservedTokens: z.number().optional(), unresolved: z.literal(true) }).strict();
const CircuitSchema = z.object({ reason: z.enum(["capacity", "authentication", "transient"]), openedAt: z.string(), fingerprint: z.string().optional(), failures: z.number().int().optional() }).strict();
const ProfileSchema = z.object({ name: z.string().min(1), home: z.string().min(1), enabled: z.boolean(), profileClass: z.enum(["subscription", "metered-api"]), concurrencyLimit: z.number().int().positive().optional(), percentageQuantum: z.number().positive().optional(), reserveFloorPercentage: z.number().min(0).max(100).optional(), activeCapacityPollIntervalMs: z.number().positive().optional(), requireRearmOnCapacityExhaustion: z.boolean().optional(), meteredMode: z.enum(["manual", "overflow", "automatic"]).optional(), budget: z.object({ tokenLimit: z.number().positive().optional(), startLimit: z.number().int().positive().optional(), concurrencyLimit: z.number().int().positive().optional(), runtimeLimitMs: z.number().positive().optional(), requireRearm: z.boolean().optional(), reservationTokens: z.number().positive().optional() }).strict().optional() }).strict();
const RegistryFileSchema = z.object({ version: z.literal(1), profiles: z.array(ProfileSchema) }).strict();
const PersistedStateFileSchema: z.ZodType<{ version: 2; state: PersistedRoutingState }> = z.object({ version: z.literal(2), state: z.object({ roundRobin: z.number().int().nonnegative(), next: z.object({ profile: z.string(), remaining: z.number().int().positive() }).strict().optional(), reservations: z.record(z.string(), ReservationFileSchema), ledgers: z.record(z.string(), LedgerSchema), circuits: z.record(z.string(), CircuitSchema), unavailableProfiles: z.record(z.string(), z.string()) }).strict() }).strict();

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
