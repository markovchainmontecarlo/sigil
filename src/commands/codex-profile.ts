import { resolve } from "node:path";

import {
  codexProfileStore,
  profileLedger,
  readCodexProfiles,
  readCodexRoutingState,
  updateCodexProfiles,
  updateCodexRoutingState,
  type CodexProfile,
  type CodexProfileClass,
  type MeteredMode,
} from "../codex-profiles.js";
import { circuitIsOpen } from "../codex-router.js";
import { primeCodexProfile } from "../agents.js";
import { CODEX_PROVIDER, loadConfig, resolveAgentBinding } from "../config.js";
import { readCodexAccountStatus } from "../codex-rate-limits.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, requireValue, value } from "./parse.js";

export async function codexProfileCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action) throw new UsageError("missing codex-profile action");
  if (action === "add") return addProfile(rest);
  if (action === "remove") return removeProfile(rest);
  if (action === "list") return listProfiles();
  if (action === "status") return profileStatus();
  if (action === "automatic") return setAutomatic();
  if (action === "next") return setNext(rest);
  if (action === "enable" || action === "disable") return setEnabled(action === "enable", rest);
  if (action === "rearm") return rearm(rest);
  if (action === "prime") return prime(rest);
  throw new UsageError(`unknown codex-profile action: ${action}`);
}

async function addProfile(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    home: { type: "string" },
    class: { type: "string" },
    mode: { type: "string" },
    concurrency: { type: "string" },
    "token-limit": { type: "string" },
    "start-limit": { type: "string" },
    "runtime-limit-ms": { type: "string" },
    "reservation-tokens": { type: "string" },
    quantum: { type: "string" },
    "reserve-floor": { type: "string" },
    "capacity-poll-ms": { type: "string" },
    "require-rearm": { type: "boolean" },
  });
  const name = parsed.positionals[0];
  if (!name) throw new UsageError("missing profile name");
  const declaredClass = value(parsed, "class");
  const candidate: CodexProfile = {
    name,
    home: resolve(requireValue(parsed, "home")),
    enabled: true,
    profileClass: parseClass(declaredClass),
    concurrencyLimit: optionalPositive(value(parsed, "concurrency")),
    percentageQuantum: optionalPositive(value(parsed, "quantum")),
    reserveFloorPercentage: optionalPercentage(value(parsed, "reserve-floor")),
    activeCapacityPollIntervalMs: optionalPositive(value(parsed, "capacity-poll-ms")),
    requireRearmOnCapacityExhaustion: parsed.values["require-rearm"] === true,
  };
  const verified = await readCodexAccountStatus(candidate);
  if (declaredClass && candidate.profileClass !== verified.profileClass) {
    throw new UsageError(`declared profile class does not match account/read: ${verified.profileClass}`);
  }
  const profile: CodexProfile = {
    ...candidate,
    profileClass: verified.profileClass,
    meteredMode: verified.profileClass === "metered-api" ? parseMode(value(parsed, "mode")) : undefined,
    budget: verified.profileClass === "metered-api" ? {
      tokenLimit: optionalPositive(value(parsed, "token-limit")),
      startLimit: optionalPositive(value(parsed, "start-limit")),
      concurrencyLimit: optionalPositive(value(parsed, "concurrency")),
      runtimeLimitMs: optionalPositive(value(parsed, "runtime-limit-ms")),
      requireRearm: parsed.values["require-rearm"] === true,
      reservationTokens: optionalPositive(value(parsed, "reservation-tokens")),
    } : undefined,
  };
  await updateCodexProfiles((profiles) => {
    if (profiles.some((entry) => entry.name === name)) throw new UsageError(`profile already exists: ${name}`);
    profiles.push(profile);
  });
  printJson({ added: name });
  return 0;
}

async function removeProfile(args: string[]): Promise<number> {
  const name = requiredName(args);
  const state = await readCodexRoutingState();
  if (Object.values(state.reservations).some((reservation) => reservation.profile === name)) {
    throw new Error(`profile ${name} has active assignments`);
  }
  await updateCodexProfiles((profiles) => {
    const index = profiles.findIndex((profile) => profile.name === name);
    if (index < 0) throw new UsageError(`unknown profile: ${name}`);
    profiles.splice(index, 1);
  });
  printJson({ removed: name });
  return 0;
}

async function listProfiles(): Promise<number> {
  printJson({ profiles: await readCodexProfiles() });
  return 0;
}

async function profileStatus(): Promise<number> {
  const profiles = await readCodexProfiles();
  const state = await readCodexRoutingState();
  printJson({ profiles: profiles.map((profile) => {
    const reservations = Object.values(state.reservations).filter((entry) => entry.profile === profile.name);
    const reservedHeadroomPercentage = reservations.reduce(
      (total, entry) => total + (entry.reservedHeadroomPercentage ?? 0),
      0,
    );
    const circuit = state.circuits[profile.name];
    const observedRemaining = reservations
      .map((entry) => entry.observedRemainingPercentage)
      .find((entry) => entry !== undefined);
    const remainingCapacityClass = circuitIsOpen(circuit)
      ? "circuit-open"
      : profile.profileClass === "metered-api"
        ? "metered"
        : observedRemaining === undefined
          ? "unobserved"
          : observedRemaining - reservedHeadroomPercentage >= (profile.reserveFloorPercentage ?? 0)
            ? "above-floor"
            : "at-or-below-floor";
    return {
    name: profile.name,
    enabled: profile.enabled,
    profileClass: profile.profileClass,
    meteredMode: profile.meteredMode,
    policy: {
      concurrencyLimit: profile.concurrencyLimit,
      percentageQuantum: profile.percentageQuantum,
      reserveFloorPercentage: profile.reserveFloorPercentage,
      activeCapacityPollIntervalMs: profile.activeCapacityPollIntervalMs,
      requireRearmOnCapacityExhaustion: profile.requireRearmOnCapacityExhaustion,
      budget: profile.budget,
    },
    ledger: profileLedger(state, profile.name),
    activeAssignments: reservations.length,
    reservedHeadroomPercentage,
    aggregateReservedPercentage: reservedHeadroomPercentage,
    remainingCapacityClass,
    circuit: circuit ? {
      reason: circuit.reason,
      state: circuitIsOpen(circuit) ? "open" : "tracking",
    } : { state: "closed" },
    };
  }) });
  return 0;
}

async function setAutomatic(): Promise<number> {
  await updateCodexRoutingState((state) => { state.next = undefined; });
  printJson({ routing: "automatic" });
  return 0;
}

async function setNext(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { agents: { type: "string" } });
  const name = parsed.positionals[0];
  if (!name) throw new UsageError("missing profile name");
  const agents = positive(requireValue(parsed, "agents"));
  const profiles = await readCodexProfiles();
  if (!profiles.some((profile) => profile.name === name && profile.enabled)) throw new UsageError(`unknown or disabled profile: ${name}`);
  await updateCodexRoutingState((state) => { state.next = { profile: name, remaining: agents }; });
  printJson({ next: name, agents });
  return 0;
}

async function setEnabled(enabled: boolean, args: string[]): Promise<number> {
  const name = requiredName(args);
  await updateCodexProfiles((profiles) => {
    const profile = profiles.find((entry) => entry.name === name);
    if (!profile) throw new UsageError(`unknown profile: ${name}`);
    profile.enabled = enabled;
  });
  printJson({ profile: name, enabled });
  return 0;
}

async function rearm(args: string[]): Promise<number> {
  const name = requiredName(args);
  await updateCodexRoutingState((state) => {
    const ledger = profileLedger(state, name);
    ledger.rearmRequired = false;
    delete state.circuits[name];
  });
  printJson({ rearmed: name });
  return 0;
}

async function prime(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { repo: { type: "string" } });
  const names = parsed.positionals.length
    ? parsed.positionals
    : (await readCodexProfiles()).filter((profile) => profile.profileClass === "subscription").map((profile) => profile.name);
  const profiles = await readCodexProfiles();
  const selected = profiles.filter((profile) => names.includes(profile.name));
  const repo = resolve(value(parsed, "repo") ?? process.cwd());
  const config = loadConfig(repo);
  const binding = resolveAgentBinding(config.implement.coder, config);
  if (binding.provider !== CODEX_PROVIDER) throw new UsageError("configured implementation binding is not Codex");
  const statuses = await Promise.all(selected.map(async (profile) => ({
    name: profile.name,
    result: await primeCodexProfile(profile, binding),
  })));
  printJson({ automaticPriming: false, profiles: statuses });
  return 0;
}

function requiredName(args: string[]): string {
  if (!args[0]) throw new UsageError("missing profile name");
  return args[0];
}

function parseClass(raw: string | undefined): CodexProfileClass {
  if (raw === undefined || raw === "subscription") return "subscription";
  if (raw === "metered-api") return raw;
  throw new UsageError(`invalid profile class: ${raw}`);
}

function parseMode(raw: string | undefined): MeteredMode {
  if (raw === undefined || raw === "overflow") return "overflow";
  if (raw === "manual" || raw === "automatic") return raw;
  throw new UsageError(`invalid metered mode: ${raw}`);
}

function optionalPositive(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : positive(raw);
}

function optionalPercentage(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new UsageError(`expected an integer percentage from 0 through 100: ${raw}`);
  }
  return parsed;
}

function positive(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`expected a positive integer: ${raw}`);
  return parsed;
}
