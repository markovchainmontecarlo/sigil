import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { acquireFileLock } from "./file-lock.js";
import {
  ProfileStoreError,
  qualifiedProfileIdentity,
  type MeteredMode,
  type SafeProfileDto,
} from "./provider-profiles.js";

export type ClaudeProfile = {
  provider: "claude";
  name: string;
  enabled: boolean;
  accessClass: "subscription" | "metered-api";
  concurrencyLimit?: number;
  mode?: MeteredMode;
  admission?: { usdLimit?: number; startLimit?: number };
  operation?: { usdLimit: number };
  details:
    | { defaultConfiguration: true }
    | { configurationDirectory: string }
    | { credentialSource: string };
};

export type ClaudeRoutingState = {
  next?: { profile: string; remaining: number };
  reservations: Record<string, { profile: string; owner: { pid: number; startIdentity: string }; startedAt: string; reservedUsd?: number }>;
  ledgers: Record<string, { starts: number; active: number; spentUsd: number; reservedUsd?: number }>;
  circuits: Record<string, { reason: "authentication" | "capacity" | "transient"; openedAt: string }>;
};

export type ClaudeProfileStore = { registryFile: string; stateFile: string; lockDir: string };

const ProfileSchema = z.object({
  provider: z.literal("claude"), name: z.string().regex(/^[a-zA-Z0-9._-]+$/), enabled: z.boolean(),
  accessClass: z.enum(["subscription", "metered-api"]), concurrencyLimit: z.number().int().positive().optional(),
  mode: z.enum(["manual", "overflow", "automatic"]).optional(),
  admission: z.object({ usdLimit: z.number().positive().optional(), startLimit: z.number().int().positive().optional() }).strict().optional(),
  operation: z.object({ usdLimit: z.number().positive() }).strict().optional(),
  details: z.union([
    z.object({ defaultConfiguration: z.literal(true) }).strict(),
    z.object({ configurationDirectory: z.string().min(1) }).strict(),
    z.object({ credentialSource: z.string().min(1) }).strict(),
  ]),
}).strict().superRefine((profile, context) => {
  if (profile.accessClass === "subscription" && "credentialSource" in profile.details) {
    context.addIssue({ code: "custom", message: "subscription profile requires Claude configuration" });
  }
  if (profile.accessClass === "metered-api") {
    if (!("credentialSource" in profile.details)) context.addIssue({ code: "custom", message: "metered profile requires a credential source" });
    if (!profile.mode) context.addIssue({ code: "custom", message: "metered profile requires an explicit mode" });
    if (!profile.admission?.usdLimit && !profile.admission?.startLimit) context.addIssue({ code: "custom", message: "metered profile requires a finite admission bound" });
    if (!profile.operation?.usdLimit) context.addIssue({ code: "custom", message: "metered profile requires a hard per-operation USD limit" });
  }
});
const RegistrySchema = z.object({ version: z.literal(1), profiles: z.array(ProfileSchema) }).strict();
const StateSchema = z.object({ version: z.literal(1), state: z.object({
  next: z.object({ profile: z.string(), remaining: z.number().int().positive() }).strict().optional(),
  reservations: z.record(z.string(), z.object({ profile: z.string(), owner: z.object({ pid: z.number().int().positive(), startIdentity: z.string().min(1) }).strict(), startedAt: z.string().datetime(), reservedUsd: z.number().positive().optional() }).strict()),
  ledgers: z.record(z.string(), z.object({ starts: z.number().int().nonnegative(), active: z.number().int().nonnegative(), spentUsd: z.number().nonnegative(), reservedUsd: z.number().nonnegative().optional() }).strict()),
  circuits: z.record(z.string(), z.object({ reason: z.enum(["authentication", "capacity", "transient"]), openedAt: z.string().datetime() }).strict()),
}).strict() }).strict();

export function claudeProfileStore(sigilHome = process.env.SIGIL_HOME): ClaudeProfileStore {
  const root = resolve(sigilHome ?? join(homedir(), ".sigil"), "claude-profiles");
  return { registryFile: join(root, "registry.json"), stateFile: join(root, "routing-state.json"), lockDir: join(root, ".lock") };
}

export async function readClaudeProfiles(store = claudeProfileStore()): Promise<ClaudeProfile[]> {
  return (await readFileChecked(store.registryFile, RegistrySchema, { version: 1, profiles: [] })).profiles;
}

export async function writeClaudeProfiles(profiles: ClaudeProfile[], store = claudeProfileStore()): Promise<void> {
  const parsed = RegistrySchema.parse({ version: 1, profiles });
  await using _lock = await acquireFileLock(store.lockDir, { recovery: "strict" });
  await atomicWrite(store.registryFile, parsed);
}

export async function updateClaudeProfiles<T>(
  update: (profiles: ClaudeProfile[]) => T | Promise<T>,
  store = claudeProfileStore(),
): Promise<T> {
  await using _lock = await acquireFileLock(store.lockDir, { recovery: "strict" });
  const profiles = await readClaudeProfiles(store);
  const result = await update(profiles);
  const parsed = RegistrySchema.parse({ version: 1, profiles });
  await atomicWrite(store.registryFile, parsed);
  return result;
}

export async function readClaudeRoutingState(store = claudeProfileStore()): Promise<ClaudeRoutingState> {
  return (await readFileChecked(store.stateFile, StateSchema, { version: 1, state: { reservations: {}, ledgers: {}, circuits: {} } })).state;
}

export async function updateClaudeRoutingState<T>(
  update: (state: ClaudeRoutingState) => T | Promise<T>,
  store = claudeProfileStore(),
): Promise<T> {
  await using _lock = await acquireFileLock(store.lockDir, { recovery: "strict" });
  const state = await readClaudeRoutingState(store);
  const result = await update(state);
  const parsed = StateSchema.parse({ version: 1, state });
  await atomicWrite(store.stateFile, parsed);
  return result;
}

export function safeClaudeProfile(profile: ClaudeProfile): SafeProfileDto {
  return {
    version: 1,
    provider: "claude",
    name: profile.name,
    qualifiedIdentity: qualifiedProfileIdentity("claude", profile.name),
    accessClass: profile.accessClass,
    enabled: profile.enabled,
    mode: profile.mode,
    admissionLimit: profile.admission?.usdLimit ? { unit: "usd", value: profile.admission.usdLimit } : profile.admission?.startLimit ? { unit: "starts", value: profile.admission.startLimit } : undefined,
    operationLimit: profile.operation ? { unit: "usd", value: profile.operation.usdLimit } : undefined,
  };
}

export function resolveClaudeCredentialSource(profile: ClaudeProfile, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!("credentialSource" in profile.details)) return undefined;
  const value = environment[profile.details.credentialSource];
  if (!value) throw new ProfileStoreError("credential-unresolved", `credential source is unresolved for ${qualifiedProfileIdentity("claude", profile.name)}`);
  return value;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readFileChecked<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    const details = await stat(path);
    if ((details.mode & 0o077) !== 0) throw new ProfileStoreError("unsafe-permissions", `unsafe permissions: ${path}`);
    const input = JSON.parse(await readFile(path, "utf8")) as unknown;
    const version = (input as { version?: unknown })?.version;
    if (typeof version === "number" && version !== (fallback as { version: number }).version) throw new ProfileStoreError("unsupported-version", `unsupported profile file version: ${version}`);
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ProfileStoreError("corrupt", `invalid profile file: ${path}`);
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) throw new ProfileStoreError("corrupt", `invalid JSON: ${path}`, { cause: error });
    throw error;
  }
}
