import { resolve } from "node:path";

import {
  readClaudeProfiles,
  readClaudeRoutingState,
  safeClaudeProfile,
  updateClaudeProfiles,
  updateClaudeRoutingState,
  type ClaudeProfile,
} from "./claude-profiles.js";
import {
  profileLedger,
  meteredUsage,
  readCodexProfiles,
  readCodexRoutingState,
  updateCodexProfiles,
  updateCodexRoutingState,
  type CodexProfile,
} from "./codex-profiles.js";
import { readCodexAccountStatus } from "./codex-rate-limits.js";
import { circuitIsOpen, type SubscriptionCapacity } from "./codex-router.js";
import { CODEX_PROVIDER, loadConfig, resolveAgentBinding } from "./config.js";
import {
  qualifiedProfileIdentity,
  resolveProfileSelector,
  type MeteredMode,
  type ProfileProvider,
  type SafeProfileDto,
} from "./provider-profiles.js";
import { UsageError } from "./commands/errors.js";
import { printJson } from "./commands/output.js";
import { parseCommandArgs, requireValue, value } from "./commands/parse.js";

type CommonProfile =
  | { provider: "codex"; name: string; profile: CodexProfile }
  | { provider: "claude"; name: string; profile: ClaudeProfile };

type OutputRecord = { version: 1; kind: string; [key: string]: unknown };
type AvailableCapacity = Extract<SubscriptionCapacity, { kind: "available" }> & {
  reservedPercentage: number;
  availablePercentage: number;
};
type CapacityEvidence =
  | { kind: "metered" }
  | Exclude<SubscriptionCapacity, { kind: "available" }>
  | AvailableCapacity;

export async function runProfileCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action) throw new UsageError("missing profile action");
  if (action === "add") return addProfile(rest);
  if (action === "remove") return mutateProfile(action, rest);
  if (action === "enable" || action === "disable") return mutateProfile(action, rest);
  if (action === "rearm") return mutateProfile(action, rest);
  if (action === "next") return setNext(rest);
  if (action === "list") return listProfiles(rest);
  if (action === "inspect") return inspectProfile(rest);
  if (action === "status") return profileStatus(rest);
  if (action === "prime") return primeProfile(rest);
  throw new UsageError(`unknown profile action: ${action}`);
}

async function addProfile(args: string[]): Promise<number> {
  const parsed = parseProfileArgs(args);
  const name = parsed.positionals[0];
  if (!name) throw new UsageError("missing profile name");
  const provider = parseProvider(requireValue(parsed, "provider"));
  const accessClass = parseClass(value(parsed, "class"));

  if (provider === "codex") await addCodexProfile(name, accessClass, parsed);
  else await addClaudeProfile(name, accessClass, parsed);

  return output({ version: 1, kind: "profile-operation", operation: "add", profile: qualifiedProfileIdentity(provider, name) }, jsonRequested(parsed));
}

async function addCodexProfile(name: string, accessClass: "subscription" | "metered-api", parsed: ReturnType<typeof parseProfileArgs>): Promise<void> {
  const candidate: CodexProfile = {
    name,
    home: resolve(requireValue(parsed, "home")),
    enabled: true,
    profileClass: accessClass,
    concurrencyLimit: optionalPositive(value(parsed, "concurrency")),
    percentageQuantum: optionalPositive(value(parsed, "quantum")),
    reserveFloorPercentage: optionalPercentage(value(parsed, "reserve-floor")),
    activeCapacityPollIntervalMs: optionalPositive(value(parsed, "capacity-poll-ms")),
    requireRearmOnCapacityExhaustion: parsed.values["require-rearm"] === true,
  };
  const verified = await readCodexAccountStatus(candidate);
  if (candidate.profileClass !== verified.profileClass) throw new UsageError(`declared profile class does not match account/read: ${verified.profileClass}`);
  const profile = { ...candidate, meteredMode: accessClass === "metered-api" ? parseMode(value(parsed, "mode")) : undefined, budget: accessClass === "metered-api" ? codexBudget(parsed) : undefined };
  if (accessClass === "metered-api") validateCodexMetered(profile);
  await updateCodexProfiles((profiles) => {
    if (profiles.some((entry) => entry.name === name)) throw new UsageError(`profile already exists: codex:${name}`);
    profiles.push(profile);
  });
}

async function addClaudeProfile(name: string, accessClass: "subscription" | "metered-api", parsed: ReturnType<typeof parseProfileArgs>): Promise<void> {
  const profile: ClaudeProfile = accessClass === "subscription"
    ? { provider: "claude", name, enabled: true, accessClass, concurrencyLimit: optionalPositive(value(parsed, "concurrency")), details: claudeSubscriptionDetails(parsed) }
    : { provider: "claude", name, enabled: true, accessClass, concurrencyLimit: optionalPositive(value(parsed, "concurrency")), mode: parseMode(value(parsed, "mode")), admission: { usdLimit: optionalPositiveNumber(value(parsed, "admission-usd")), startLimit: optionalPositive(value(parsed, "start-limit")) }, operation: { usdLimit: positiveNumber(requireValue(parsed, "operation-usd")) }, details: { credentialSource: requireValue(parsed, "credential-source") } };
  await updateClaudeProfiles((profiles) => {
    if (profiles.some((entry) => entry.name === name)) throw new UsageError(`profile already exists: claude:${name}`);
    profiles.push(profile);
  });
}

function claudeSubscriptionDetails(parsed: ReturnType<typeof parseProfileArgs>): ClaudeProfile["details"] {
  if (parsed.values["default-config"] === true) return { defaultConfiguration: true };
  return { configurationDirectory: resolve(requireValue(parsed, "config-dir")) };
}

async function mutateProfile(action: "remove" | "enable" | "disable" | "rearm", args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { json: { type: "boolean" } });
  const selected = await selectedProfile(parsed.positionals[0]);
  if (action === "remove") await removeSelected(selected);
  if (action === "enable" || action === "disable") await setEnabled(selected, action === "enable");
  if (action === "rearm") await rearmSelected(selected);
  return output({ version: 1, kind: "profile-operation", operation: action, profile: identity(selected) }, jsonRequested(parsed));
}

async function listProfiles(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { provider: { type: "string" }, json: { type: "boolean" } });
  const provider = optionalProvider(value(parsed, "provider"));
  const profiles = (await allProfiles()).filter((entry) => !provider || entry.provider === provider).map(safeProfile);
  return output({ version: 1, kind: "profile-list", profiles }, jsonRequested(parsed));
}

async function inspectProfile(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { json: { type: "boolean" } });
  const selected = await selectedProfile(parsed.positionals[0]);
  const state = await storedState(selected);
  return output({ version: 1, kind: "profile-inspection", profile: safeProfile(selected), state }, jsonRequested(parsed));
}

async function profileStatus(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { provider: { type: "string" }, json: { type: "boolean" } });
  const provider = optionalProvider(value(parsed, "provider"));
  const profiles = (await allProfiles()).filter((entry) => !provider || entry.provider === provider);
  const statuses = await Promise.all(profiles.map(statusRecord));
  return output({ version: 1, kind: "profile-status", profiles: statuses }, jsonRequested(parsed));
}

async function setNext(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { agents: { type: "string" }, json: { type: "boolean" } });
  const selected = await selectedProfile(parsed.positionals[0]);
  const agents = positive(requireValue(parsed, "agents"));
  await assertNextEligible(selected);
  if (selected.provider === "codex") await updateCodexRoutingState((state) => { state.next = { profile: selected.name, remaining: agents }; });
  else await updateClaudeRoutingState((state) => { state.next = { profile: selected.name, remaining: agents }; });
  return output({ version: 1, kind: "profile-operation", operation: "next", profile: identity(selected), agents }, jsonRequested(parsed));
}

async function primeProfile(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { repo: { type: "string" }, json: { type: "boolean" } });
  const selected = await selectedProfile(parsed.positionals[0]);
  if (selected.provider === "claude") {
    return output({ version: 1, kind: "profile-operation", operation: "prime", profile: identity(selected), support: "unsupported" }, jsonRequested(parsed));
  }
  if (selected.profile.profileClass !== "subscription") throw new UsageError("prime requires a Codex subscription profile");
  await assertNextEligible(selected, false);
  const config = loadConfig(resolve(value(parsed, "repo") ?? process.cwd()));
  const binding = resolveAgentBinding(config.implement.coder, config);
  if (binding.provider !== CODEX_PROVIDER) throw new UsageError("configured implementation binding is not Codex");
  const { primeCodexProfile } = await import("./providers/codex.js");
  const result = await primeCodexProfile(selected.profile, binding);
  return output({ version: 1, kind: "profile-operation", operation: "prime", profile: identity(selected), support: "supported", outcome: result.windowStarted ? "primed" : "active" }, jsonRequested(parsed));
}

async function allProfiles(): Promise<CommonProfile[]> {
  const codex = (await readCodexProfiles()).map((profile): CommonProfile => ({ provider: "codex", name: profile.name, profile }));
  const claude = (await readClaudeProfiles()).map((profile): CommonProfile => ({ provider: "claude", name: profile.name, profile }));
  return [...codex, ...claude];
}

async function selectedProfile(selector: string | undefined): Promise<CommonProfile> {
  if (!selector) throw new UsageError("missing profile selector");
  try { return resolveProfileSelector(selector, await allProfiles()); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
}

function safeProfile(selected: CommonProfile): SafeProfileDto & { policy: Record<string, unknown> } {
  if (selected.provider === "claude") return { ...safeClaudeProfile(selected.profile), policy: { concurrencyLimit: selected.profile.concurrencyLimit } };
  const profile = selected.profile;
  return {
    version: 1, provider: "codex", name: profile.name, qualifiedIdentity: identity(selected), accessClass: profile.profileClass,
    enabled: profile.enabled, mode: profile.meteredMode,
    admissionLimit: codexAdmissionLimit(profile), operationLimit: profile.budget?.reservationTokens ? { unit: "tokens", value: profile.budget.reservationTokens } : undefined,
    policy: { concurrencyLimit: profile.concurrencyLimit, percentageQuantum: profile.percentageQuantum, reserveFloorPercentage: profile.reserveFloorPercentage, activeCapacityPollIntervalMs: profile.activeCapacityPollIntervalMs, requireRearmOnCapacityExhaustion: profile.requireRearmOnCapacityExhaustion },
  };
}

async function storedState(selected: CommonProfile): Promise<Record<string, unknown>> {
  if (selected.provider === "claude") {
    const { reconcileClaudeRoutingState } = await import("./claude-router.js");
    await reconcileClaudeRoutingState();
    const state = await readClaudeRoutingState();
    return { ledger: state.ledgers[selected.name], activeAssignments: Object.values(state.reservations).filter((entry) => entry.profile === selected.name).length, circuit: state.circuits[selected.name] ? { state: "open", reason: state.circuits[selected.name].reason } : { state: "closed" } };
  }
  const state = await readCodexRoutingState();
  const reservations = Object.values(state.reservations).filter((entry) => entry.profile === selected.name);
  const circuit = state.circuits[selected.name];
  const activity = profileLedger(state, selected.name);
  const usage = selected.profile.profileClass === "metered-api"
    ? { meteredUsage: meteredUsage(state, selected.name) }
    : {};
  const reservedHeadroomPercentage = reservations.reduce(
    (sum, entry) => sum + (entry.reservedHeadroomPercentage ?? 0),
    0,
  );
  const circuitState = circuit
    ? { state: circuitIsOpen(circuit) ? "open" : "tracking", reason: circuit.reason }
    : { state: "closed" };
  return {
    activity,
    ...usage,
    activeAssignments: reservations.length,
    reservedHeadroomPercentage,
    circuit: circuitState,
  };
}

async function statusRecord(selected: CommonProfile): Promise<Record<string, unknown>> {
  const state = await storedState(selected);
  if (selected.provider === "claude") return { profile: safeProfile(selected), state, eligibility: selected.profile.enabled && (state.circuit as { state: string }).state === "closed" ? "eligible" : "ineligible", evidence: { authentication: { kind: "unknown" }, capacity: { kind: "unknown" } } };
  const profile = selected.profile;
  const routing = await readCodexRoutingState();
  const reservations = Object.values(routing.reservations).filter((entry) => entry.profile === selected.name);
  const reserved = reservations.reduce((sum, entry) => sum + (entry.reservedHeadroomPercentage ?? 0), 0);
  const account = await readCodexAccountStatus(profile);
  const capacity = capacityEvidence(profile, account.capacity, reserved);
  const eligible = basicCodexEligibility(profile, routing)
    && canAdmitFromCapacity(profile, capacity);
  return {
    profile: safeProfile(selected),
    state,
    eligibility: eligible ? "eligible" : "ineligible",
    evidence: {
      authentication: {
        kind: account.capacity.kind === "authentication" ? "failed" : "unknown",
      },
      capacity,
    },
  };
}

function capacityEvidence(
  profile: CodexProfile,
  capacity: Awaited<ReturnType<typeof readCodexAccountStatus>>["capacity"],
  reservedPercentage: number,
): CapacityEvidence {
  if (profile.profileClass === "metered-api") return { kind: "metered" };
  if (capacity.kind !== "available") return capacity;
  return {
    ...capacity,
    reservedPercentage,
    availablePercentage: Math.max(0, capacity.remainingPercentage - reservedPercentage),
  };
}

function canAdmitFromCapacity(
  profile: CodexProfile,
  capacity: CapacityEvidence,
): boolean {
  if (profile.profileClass === "metered-api") return true;
  if (capacity.kind !== "available") return false;
  return capacity.availablePercentage - (profile.percentageQuantum ?? 0)
    >= (profile.reserveFloorPercentage ?? 0);
}

async function removeSelected(selected: CommonProfile): Promise<void> {
  const state = await storedState(selected);
  if ((state.activeAssignments as number) > 0) throw new Error(`profile ${identity(selected)} has active assignments`);
  if (selected.provider === "codex") await updateCodexProfiles((profiles) => profiles.splice(profiles.findIndex((entry) => entry.name === selected.name), 1));
  else await updateClaudeProfiles((profiles) => profiles.splice(profiles.findIndex((entry) => entry.name === selected.name), 1));
}

async function setEnabled(selected: CommonProfile, enabled: boolean): Promise<void> {
  if (selected.provider === "codex") await updateCodexProfiles((profiles) => { profiles.find((entry) => entry.name === selected.name)!.enabled = enabled; });
  else await updateClaudeProfiles((profiles) => { profiles.find((entry) => entry.name === selected.name)!.enabled = enabled; });
}

async function rearmSelected(selected: CommonProfile): Promise<void> {
  if (selected.provider === "codex") await updateCodexRoutingState((state) => { profileLedger(state, selected.name).rearmRequired = false; delete state.circuits[selected.name]; });
  else await updateClaudeRoutingState((state) => { delete state.circuits[selected.name]; });
}

async function assertNextEligible(selected: CommonProfile, checkBudget = true): Promise<void> {
  if (!selected.profile.enabled) throw new UsageError(`profile is disabled: ${identity(selected)}`);
  if (selected.provider === "claude") {
    const state = await readClaudeRoutingState();
    if (state.circuits[selected.name]) throw new UsageError(`profile circuit is open: ${identity(selected)}`);
    if (checkBudget && selected.profile.accessClass === "metered-api") {
      const ledger = state.ledgers[selected.name];
      if (selected.profile.admission?.startLimit !== undefined && (ledger?.starts ?? 0) >= selected.profile.admission.startLimit) throw new UsageError(`profile budget is exhausted: ${identity(selected)}`);
      if (selected.profile.admission?.usdLimit !== undefined && (ledger?.spentUsd ?? 0) >= selected.profile.admission.usdLimit) throw new UsageError(`profile budget is exhausted: ${identity(selected)}`);
    }
    return;
  }
  const state = await readCodexRoutingState();
  if (!basicCodexEligibility(selected.profile, state)) throw new UsageError(`profile is not eligible: ${identity(selected)}`);
}

function basicCodexEligibility(profile: CodexProfile, state: Awaited<ReturnType<typeof readCodexRoutingState>>): boolean {
  if (!profile.enabled || circuitIsOpen(state.circuits[profile.name]) || profileLedger(state, profile.name).rearmRequired) return false;
  const ledger = profileLedger(state, profile.name);
  if (profile.profileClass === "metered-api") {
    if (profile.budget?.startLimit !== undefined && ledger.starts >= profile.budget.startLimit) return false;
    if (profile.budget?.runtimeLimitMs !== undefined && ledger.runtimeMs >= profile.budget.runtimeLimitMs) return false;
    const usage = meteredUsage(state, profile.name);
    if (profile.budget?.tokenLimit !== undefined && usage.usage.totalTokens + usage.reservedTokens >= profile.budget.tokenLimit) return false;
  }
  const reservations = Object.values(state.reservations).filter((entry) => entry.profile === profile.name);
  if ((profile.concurrencyLimit ?? profile.budget?.concurrencyLimit) !== undefined && reservations.length >= (profile.concurrencyLimit ?? profile.budget?.concurrencyLimit)!) return false;
  const observed = reservations.find((entry) => entry.observedRemainingPercentage !== undefined)?.observedRemainingPercentage;
  const reserved = reservations.reduce((sum, entry) => sum + (entry.reservedHeadroomPercentage ?? 0), 0);
  return profile.profileClass !== "subscription" || observed === undefined || observed - reserved - (profile.percentageQuantum ?? 0) >= (profile.reserveFloorPercentage ?? 0);
}

function output(record: OutputRecord, json: boolean): 0 {
  if (json) printJson(record);
  else if (Array.isArray(record.profiles)) for (const profile of record.profiles) console.log(humanProfile(profile));
  else if (record.kind === "profile-inspection" && record.profile) console.log(humanProfile(record.profile));
  else console.log([record.operation, record.profile, record.support, record.outcome].filter(Boolean).join(" ") || record.kind);
  return 0;
}

function humanProfile(value: unknown): string {
  const record = value as {
    profile?: SafeProfileDto;
    qualifiedIdentity?: string;
    accessClass?: string;
    enabled?: boolean;
    eligibility?: string;
    evidence?: {
      capacity?: {
        kind?: string;
        remainingPercentage?: number;
        reservedPercentage?: number;
        availablePercentage?: number;
      };
    };
  };
  const profile = record.profile ?? record;
  const capacity = record.evidence?.capacity;
  const percentage = capacity?.kind === "available"
    ? `${capacity.remainingPercentage}% remaining, ${capacity.reservedPercentage}% reserved, ${capacity.availablePercentage}% available`
    : capacity?.kind;
  return [
    profile.qualifiedIdentity,
    profile.accessClass,
    profile.enabled ? "enabled" : "disabled",
    record.eligibility,
    percentage,
  ].filter(Boolean).join(" ");
}

function parseProfileArgs(args: string[]) { return parseCommandArgs(args, { provider: { type: "string" }, class: { type: "string" }, home: { type: "string" }, "config-dir": { type: "string" }, "default-config": { type: "boolean" }, "credential-source": { type: "string" }, mode: { type: "string" }, concurrency: { type: "string" }, "token-limit": { type: "string" }, "start-limit": { type: "string" }, "runtime-limit-ms": { type: "string" }, "reservation-tokens": { type: "string" }, "admission-usd": { type: "string" }, "operation-usd": { type: "string" }, quantum: { type: "string" }, "reserve-floor": { type: "string" }, "capacity-poll-ms": { type: "string" }, "require-rearm": { type: "boolean" }, json: { type: "boolean" } }); }
function jsonRequested(parsed: { values: Record<string, unknown> }): boolean { return parsed.values.json === true; }
function identity(selected: CommonProfile) { return qualifiedProfileIdentity(selected.provider, selected.name); }
function parseProvider(raw: string): ProfileProvider { if (raw === "codex" || raw === "claude") return raw; throw new UsageError(`invalid provider: ${raw}`); }
function optionalProvider(raw: string | undefined): ProfileProvider | undefined { return raw === undefined ? undefined : parseProvider(raw); }
function parseClass(raw: string | undefined): "subscription" | "metered-api" { if (raw === undefined || raw === "subscription") return "subscription"; if (raw === "metered-api") return raw; throw new UsageError(`invalid profile class: ${raw}`); }
function parseMode(raw: string | undefined): MeteredMode { if (raw === "manual" || raw === "overflow" || raw === "automatic") return raw; throw new UsageError("metered profile requires --mode manual|overflow|automatic"); }
function positive(raw: string): number { const parsed = Number(raw); if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`expected a positive integer: ${raw}`); return parsed; }
function positiveNumber(raw: string): number { const parsed = Number(raw); if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`expected a positive number: ${raw}`); return parsed; }
function optionalPositive(raw: string | undefined) { return raw === undefined ? undefined : positive(raw); }
function optionalPositiveNumber(raw: string | undefined) { return raw === undefined ? undefined : positiveNumber(raw); }
function optionalPercentage(raw: string | undefined) { if (raw === undefined) return undefined; const parsed = Number(raw); if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) throw new UsageError(`expected an integer percentage from 0 through 100: ${raw}`); return parsed; }
function codexBudget(parsed: ReturnType<typeof parseProfileArgs>) { return { tokenLimit: optionalPositive(value(parsed, "token-limit")), startLimit: optionalPositive(value(parsed, "start-limit")), concurrencyLimit: optionalPositive(value(parsed, "concurrency")), runtimeLimitMs: optionalPositive(value(parsed, "runtime-limit-ms")), requireRearm: parsed.values["require-rearm"] === true, reservationTokens: optionalPositive(value(parsed, "reservation-tokens")) }; }
function validateCodexMetered(profile: CodexProfile) { if (!profile.meteredMode) throw new UsageError("metered profile requires an explicit mode"); if (!profile.budget?.tokenLimit && !profile.budget?.startLimit && !profile.budget?.runtimeLimitMs) throw new UsageError("metered profile requires a finite admission bound"); if (!profile.budget?.reservationTokens) throw new UsageError("metered profile requires --reservation-tokens as a per-operation limit"); }
function codexAdmissionLimit(profile: CodexProfile): SafeProfileDto["admissionLimit"] { if (profile.budget?.tokenLimit) return { unit: "tokens", value: profile.budget.tokenLimit }; if (profile.budget?.startLimit) return { unit: "starts", value: profile.budget.startLimit }; if (profile.budget?.runtimeLimitMs) return { unit: "milliseconds", value: profile.budget.runtimeLimitMs }; return undefined; }
