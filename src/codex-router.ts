import {
  newReservation,
  profileLedger,
  readCodexRoutingState,
  readCodexProfiles,
  updateCodexRoutingState,
  type CodexCircuitReason,
  type CodexProfile,
  type CodexProfileStore,
  type CodexRoutingState,
  type CodexUsage,
  type ProfileReservation,
} from "./codex-profiles.js";
import type { ProviderFailure } from "./provider-failure.js";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import {
  qualifiedProfileIdentity,
  type QualifiedProfileIdentity,
  type ReservationLiveness,
} from "./provider-profiles.js";

export const CAPACITY_FRESHNESS_MS = 30_000;
export const TRANSIENT_CIRCUIT_THRESHOLD = 3;

export type CodexCapacityTelemetry = {
  profile: string;
  capacityClass: "above-floor" | "at-or-below-floor" | SubscriptionCapacity["kind"];
  configuredFloor: number;
  admissionOutcome: "assigned" | "blocked";
  capacityTriggeredCancellation: boolean;
};

export type SubscriptionCapacity =
  | { kind: "available"; available: true; observedAt: string; remainingPercentage: number }
  | { kind: "unavailable"; available: false; observedAt: string }
  | { kind: "unknown"; available: false; observedAt: string; message?: string }
  | { kind: "authentication"; available: false; observedAt: string; message?: string }
  | { kind: "configuration"; available: false; observedAt: string; message?: string };

type LegacySubscriptionCapacity = {
  remainingPercentage?: number;
  available: boolean;
};

export type CapacityReader = (
  profile: CodexProfile,
) => Promise<SubscriptionCapacity | LegacySubscriptionCapacity>;
export type CodexAssignment = { qualifiedIdentity: `codex:${string}`; profile: CodexProfile; reservation: ProfileReservation };
export type CodexAdmission =
  | { status: "assigned"; assignment: CodexAssignment; telemetry: CodexCapacityTelemetry[] }
  | { status: "capacity-blocked"; reasons: string[]; telemetry: CodexCapacityTelemetry[] }
  | { status: "configuration-error"; errors: string[]; telemetry: CodexCapacityTelemetry[] };

export type ReservationReconciliationOutcome = {
  profile: QualifiedProfileIdentity;
  outcome: "settled" | "retained-live" | "retained-unverifiable";
};
export type ReservationReconciliation = {
  outcomes: ReservationReconciliationOutcome[];
  blocked: boolean;
};

export async function reserveCodexProfile(
  readCapacity: CapacityReader,
  store?: CodexProfileStore,
): Promise<CodexAdmission> {
  const profiles = await readCodexProfiles(store);
  const configurationErrors = validateRoutingProfiles(profiles);
  if (configurationErrors.length) {
    return { status: "configuration-error", errors: configurationErrors, telemetry: [] };
  }

  const capacities = await readCapacities(profiles, readCapacity);
  const owner = await readProcessIdentity();
  return updateCodexRoutingState((state) => admitProfile(profiles, capacities, state, owner), store);
}

export async function releaseCodexProfile(
  reservationId: string,
  usage: CodexUsage | undefined,
  outcomeOrStore?: ProviderFailure | CodexProfileStore,
  maybeStore?: CodexProfileStore,
): Promise<void> {
  const outcome = isProfileStore(outcomeOrStore) ? undefined : outcomeOrStore;
  const store = isProfileStore(outcomeOrStore) ? outcomeOrStore : maybeStore;
  const profiles = await readCodexProfiles(store);

  await updateCodexRoutingState((state) => {
    const reservation = state.reservations[reservationId];
    if (!reservation) return;
    settleReservation(state, profiles, reservation, usage);
    transitionCircuit(state, reservation.profile, outcome);
  }, store);
}

export async function recordActiveCapacityExhaustion(
  reservationId: string,
  observedAt: string,
  store?: CodexProfileStore,
): Promise<boolean> {
  const profiles = await readCodexProfiles(store);
  return updateCodexRoutingState((state) => {
    const reservation = state.reservations[reservationId];
    if (!reservation) return false;
    const profile = profiles.find((entry) => entry.name === reservation.profile);
    state.circuits[reservation.profile] = { reason: "capacity", openedAt: observedAt };
    if (profile?.requireRearmOnCapacityExhaustion) {
      profileLedger(state, reservation.profile).rearmRequired = true;
    }
    return true;
  }, store);
}

export async function resolveUnfinishedReservations(
  store?: CodexProfileStore,
): Promise<ReservationReconciliation> {
  const profiles = await readCodexProfiles(store);
  const liveness = new Map<string, ReservationLiveness>();
  const state = await readCodexRoutingState(store);
  for (const reservation of Object.values(state.reservations)) {
    try {
      const status = await processIdentityStatus(reservation.owner);
      liveness.set(reservation.id, status === "match" ? "live" : "dead");
    } catch {
      liveness.set(reservation.id, "unverifiable");
    }
  }
  await updateCodexRoutingState((state) => {
    for (const reservation of Object.values(state.reservations)) {
      const status = liveness.get(reservation.id);
      if (status === "dead") settleReservation(state, profiles, reservation, undefined);
      if (status === "unverifiable") state.unavailableProfiles[reservation.profile] = "reservation owner is unverifiable";
    }
  }, store);
  const outcomes = Object.values(state.reservations).map((reservation) => {
    const status = liveness.get(reservation.id);
    return {
      profile: qualifiedProfileIdentity("codex", reservation.profile),
      outcome: status === "dead"
        ? "settled" as const
        : status === "live"
          ? "retained-live" as const
          : "retained-unverifiable" as const,
    };
  });
  return {
    outcomes,
    blocked: outcomes.some((outcome) => outcome.outcome !== "settled"),
  };
}

function admitProfile(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
  owner: ProcessIdentity,
): CodexAdmission {
  const profile = selectProfile(profiles, capacities, state);
  if (!profile) return blockedAdmission(profiles, capacities, state);

  const reservation = reserveProfile(profile, capacities.get(profile.name), state, owner);
  consumeManualAssignment(state, profile.name);
  return {
    status: "assigned",
    assignment: { qualifiedIdentity: qualifiedProfileIdentity("codex", profile.name), profile, reservation },
    telemetry: capacityTelemetry(profiles, capacities, profile.name),
  };
}

function selectProfile(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
): CodexProfile | undefined {
  applyProbeCircuits(profiles, capacities, state);
  const manual = selectManualProfile(profiles, capacities, state);
  if (manual) return manual;

  const subscriptions = profiles
    .filter((profile) => profile.profileClass === "subscription")
    .filter((profile) => eligibleSubscription(profile, capacities.get(profile.name), state));
  const subscription = selectSubscription(subscriptions, capacities, state.roundRobin);
  if (subscription) state.roundRobin++;
  if (subscription) return subscription;

  return profiles
    .filter((profile) => profile.profileClass === "metered-api")
    .filter((profile) => profile.meteredMode === "overflow" || profile.meteredMode === "automatic")
    .find((profile) => eligibleMetered(profile, state));
}

function selectManualProfile(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
): CodexProfile | undefined {
  if (!state.next?.remaining) return undefined;
  const profile = profiles.find((entry) => entry.name === state.next?.profile);
  if (!profile) return undefined;
  if (profile.profileClass === "metered-api") return eligibleMetered(profile, state) ? profile : undefined;
  return eligibleSubscription(profile, capacities.get(profile.name), state) ? profile : undefined;
}

function eligibleSubscription(
  profile: CodexProfile,
  capacity: SubscriptionCapacity | undefined,
  state: CodexRoutingState,
): boolean {
  if (!profile.enabled || state.unavailableProfiles[profile.name]) return false;
  if (circuitIsOpen(state.circuits[profile.name])) return false;
  if (profileLedger(state, profile.name).rearmRequired) return false;
  if (atConcurrencyLimit(profile, state)) return false;
  if (!isFreshAvailable(capacity)) return false;

  const activeHeadroom = Object.values(state.reservations)
    .filter((reservation) => reservation.profile === profile.name)
    .reduce((total, reservation) => total + (reservation.reservedHeadroomPercentage ?? 0), 0);
  const quantum = profile.percentageQuantum ?? 0;
  const floor = profile.reserveFloorPercentage ?? 0;
  return capacity.remainingPercentage - activeHeadroom - quantum >= floor;
}

function eligibleMetered(profile: CodexProfile, state: CodexRoutingState): boolean {
  if (!profile.enabled || state.unavailableProfiles[profile.name]) return false;
  if (circuitIsOpen(state.circuits[profile.name])) return false;
  const ledger = profileLedger(state, profile.name);
  if (atConcurrencyLimit(profile, state)) return false;
  if (ledger.rearmRequired) return false;
  if (profile.budget?.startLimit !== undefined && ledger.starts >= profile.budget.startLimit) return false;
  if (profile.budget?.runtimeLimitMs !== undefined && ledger.runtimeMs >= profile.budget.runtimeLimitMs) return false;
  return remainingTokenBudget(profile, state) !== 0;
}

function reserveProfile(
  profile: CodexProfile,
  capacity: SubscriptionCapacity | undefined,
  state: CodexRoutingState,
  owner: ProcessIdentity,
): ProfileReservation {
  const available = capacity?.kind === "available" ? capacity : undefined;
  const reservedTokens = profile.profileClass === "metered-api"
    ? reservationTokenAmount(profile, state)
    : undefined;
  const reservation = newReservation(profile.name, {
    owner,
    startingPercentage: available?.remainingPercentage,
    percentageQuantum: profile.percentageQuantum,
    observedAt: available?.observedAt,
    observedRemainingPercentage: available?.remainingPercentage,
    reservedHeadroomPercentage: profile.profileClass === "subscription"
      ? profile.percentageQuantum ?? 0
      : undefined,
    reservedTokens,
  });
  const ledger = profileLedger(state, profile.name);
  ledger.active++;
  ledger.starts++;
  ledger.reservedTokens += reservedTokens ?? 0;
  state.reservations[reservation.id] = reservation;
  return reservation;
}

function blockedAdmission(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
): CodexAdmission {
  const configuration = [...capacities.values()].filter((capacity) => capacity.kind === "configuration");
  if (configuration.length) {
    return {
      status: "configuration-error",
      errors: configuration.map((entry) => entry.message ?? "invalid Codex profile"),
      telemetry: capacityTelemetry(profiles, capacities),
    };
  }
  const reasons = profiles.map((profile) => blockReason(profile, capacities.get(profile.name), state));
  return {
    status: "capacity-blocked",
    reasons: [...new Set(reasons)],
    telemetry: capacityTelemetry(profiles, capacities),
  };
}

function blockReason(
  profile: CodexProfile,
  capacity: SubscriptionCapacity | undefined,
  state: CodexRoutingState,
): string {
  if (state.unavailableProfiles[profile.name]) return state.unavailableProfiles[profile.name];
  if (circuitIsOpen(state.circuits[profile.name])) return `${state.circuits[profile.name].reason} circuit open`;
  if (!profile.enabled) return `${profile.name} disabled`;
  if (atConcurrencyLimit(profile, state)) return `${profile.name} concurrency limit`;
  if (profile.profileClass === "subscription" && !isFreshAvailable(capacity)) return `${profile.name} capacity unavailable`;
  return `${profile.name} budget or reserve floor exhausted`;
}

function isFreshAvailable(capacity: SubscriptionCapacity | undefined): capacity is Extract<SubscriptionCapacity, { kind: "available" }> {
  if (capacity?.kind !== "available") return false;
  const observed = Date.parse(capacity.observedAt);
  return Number.isFinite(observed)
    && Date.now() - observed >= 0
    && Date.now() - observed <= CAPACITY_FRESHNESS_MS;
}

function applyProbeCircuits(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
): void {
  for (const [profile, capacity] of capacities) {
    const configured = profiles.find((entry) => entry.name === profile);
    const reserved = Object.values(state.reservations)
      .filter((entry) => entry.profile === profile)
      .reduce((total, entry) => total + (entry.reservedHeadroomPercentage ?? 0), 0);
    const aboveFloor = isFreshAvailable(capacity)
      && capacity.remainingPercentage - reserved >= (configured?.reserveFloorPercentage ?? 0);
    const rearmRequired = profileLedger(state, profile).rearmRequired;
    if ((state.circuits[profile]?.reason === "capacity" || state.circuits[profile]?.reason === "authentication")
      && aboveFloor
      && !rearmRequired) {
      delete state.circuits[profile];
    }
    if (capacity.kind === "unavailable") {
      state.circuits[profile] = { reason: "capacity", openedAt: capacity.observedAt };
    }
    if (capacity.kind === "authentication") {
      state.circuits[profile] = { reason: "authentication", openedAt: capacity.observedAt };
    }
  }
}

function transitionCircuit(
  state: CodexRoutingState,
  profile: string,
  outcome: ProviderFailure | undefined,
): void {
  if (!outcome) {
    if (state.circuits[profile]?.reason === "transient") delete state.circuits[profile];
    return;
  }
  const reason = circuitReason(outcome);
  if (!reason) return;
  if (reason === "transient") {
    const previous = state.circuits[profile];
    const failures = previous?.reason === "transient" ? (previous.failures ?? 0) + 1 : 1;
    if (failures < TRANSIENT_CIRCUIT_THRESHOLD) {
      state.circuits[profile] = {
        reason,
        openedAt: new Date().toISOString(),
        fingerprint: outcome?.fingerprint,
        failures,
      };
      return;
    }
  }
  state.circuits[profile] = {
    reason,
    openedAt: new Date().toISOString(),
    fingerprint: outcome?.fingerprint,
    failures: reason === "transient" ? TRANSIENT_CIRCUIT_THRESHOLD : undefined,
  };
}

export function circuitIsOpen(circuit: CodexRoutingState["circuits"][string] | undefined): boolean {
  return Boolean(circuit && (circuit.reason !== "transient" || (circuit.failures ?? TRANSIENT_CIRCUIT_THRESHOLD) >= TRANSIENT_CIRCUIT_THRESHOLD));
}

function circuitReason(outcome: ProviderFailure | undefined): CodexCircuitReason | undefined {
  if (outcome?.code === "capacity_exhausted") return "capacity";
  if (outcome?.code === "authentication_failed") return "authentication";
  if (outcome?.code === "transient" || outcome?.code === "operation_timeout" || outcome?.code === "idle_timeout") return "transient";
  return undefined;
}

function settleReservation(
  state: CodexRoutingState,
  profiles: CodexProfile[],
  reservation: ProfileReservation,
  usage: CodexUsage | undefined,
): void {
  const profile = profiles.find((entry) => entry.name === reservation.profile);
  const ledger = profileLedger(state, reservation.profile);
  const charged = usage ?? conservativeUsage(reservation.reservedTokens);
  ledger.active = Math.max(0, ledger.active - 1);
  ledger.reservedTokens = Math.max(0, ledger.reservedTokens - (reservation.reservedTokens ?? 0));
  ledger.runtimeMs += Math.max(0, Date.now() - Date.parse(reservation.startedAt));
  addUsage(ledger.usage, charged);
  if (profile?.budget?.requireRearm) ledger.rearmRequired = true;
  delete state.reservations[reservation.id];
}

function atConcurrencyLimit(profile: CodexProfile, state: CodexRoutingState): boolean {
  const ledger = profileLedger(state, profile.name);
  const limit = profile.budget?.concurrencyLimit ?? profile.concurrencyLimit;
  return limit !== undefined && ledger.active >= limit;
}

function remainingTokenBudget(profile: CodexProfile, state: CodexRoutingState): number | undefined {
  const limit = profile.budget?.tokenLimit;
  if (limit === undefined) return undefined;
  const ledger = profileLedger(state, profile.name);
  return Math.max(0, limit - ledger.usage.totalTokens - ledger.reservedTokens);
}

function reservationTokenAmount(profile: CodexProfile, state: CodexRoutingState): number | undefined {
  const remaining = remainingTokenBudget(profile, state);
  if (remaining === undefined) return profile.budget?.reservationTokens;
  return Math.min(remaining, profile.budget?.reservationTokens ?? remaining);
}

function selectSubscription(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  roundRobin: number,
): CodexProfile | undefined {
  const maximum = Math.max(...profiles.map((profile) => {
    const capacity = capacities.get(profile.name);
    return capacity?.kind === "available" ? capacity.remainingPercentage : -1;
  }));
  const tied = profiles
    .filter((profile) => capacities.get(profile.name)?.kind === "available")
    .filter((profile) => (capacities.get(profile.name) as Extract<SubscriptionCapacity, { kind: "available" }>).remainingPercentage === maximum)
    .sort((left, right) => left.name.localeCompare(right.name));
  return tied.length ? tied[roundRobin % tied.length] : undefined;
}

export async function readCapacities(
  profiles: CodexProfile[],
  readCapacity: CapacityReader,
): Promise<Map<string, SubscriptionCapacity>> {
  const subscriptions = profiles.filter((profile) => profile.profileClass === "subscription");
  const entries = await Promise.all(subscriptions.map(async (profile) => {
    try {
      return [profile.name, normalizeCapacity(await readCapacity(profile))] as const;
    } catch (error) {
      return [profile.name, {
        kind: "unknown",
        available: false,
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      } satisfies SubscriptionCapacity] as const;
    }
  }));
  return new Map(entries);
}

function normalizeCapacity(capacity: SubscriptionCapacity | LegacySubscriptionCapacity): SubscriptionCapacity {
  if ("kind" in capacity) return capacity;
  const observedAt = new Date().toISOString();
  if (capacity.available && capacity.remainingPercentage !== undefined) {
    return { kind: "available", available: true, observedAt, remainingPercentage: capacity.remainingPercentage };
  }
  return { kind: "unavailable", available: false, observedAt };
}

function validateRoutingProfiles(profiles: CodexProfile[]): string[] {
  if (!profiles.length) return ["no Codex profiles configured"];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const profile of profiles) {
    if (!profile.name?.trim() || names.has(profile.name)) errors.push(`invalid or duplicate profile name: ${profile.name}`);
    if (!profile.home?.trim()) errors.push(`profile ${profile.name} requires an explicit home`);
    if (profile.profileClass === "subscription" && profile.meteredMode) errors.push(`subscription profile ${profile.name} cannot set metered mode`);
    if (profile.profileClass === "metered-api" && !profile.meteredMode) errors.push(`metered profile ${profile.name} requires an explicit mode`);
    if (profile.percentageQuantum !== undefined && profile.percentageQuantum <= 0) errors.push(`profile ${profile.name} has an invalid percentage quantum`);
    if (profile.reserveFloorPercentage !== undefined && (profile.reserveFloorPercentage < 0 || profile.reserveFloorPercentage > 100)) {
      errors.push(`profile ${profile.name} has an invalid reserve floor`);
    }
    if (profile.activeCapacityPollIntervalMs !== undefined && profile.activeCapacityPollIntervalMs <= 0) {
      errors.push(`profile ${profile.name} has an invalid active capacity poll interval`);
    }
    names.add(profile.name);
  }
  return errors;
}

function capacityTelemetry(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  assignedProfile?: string,
): CodexCapacityTelemetry[] {
  return profiles
    .filter((profile) => profile.profileClass === "subscription")
    .map((profile) => ({
      profile: profile.name,
      capacityClass: capacityClass(capacities.get(profile.name), profile.reserveFloorPercentage ?? 0),
      configuredFloor: profile.reserveFloorPercentage ?? 0,
      admissionOutcome: profile.name === assignedProfile ? "assigned" : "blocked",
      capacityTriggeredCancellation: false,
    }));
}

function capacityClass(
  capacity: SubscriptionCapacity | undefined,
  floor: number,
): CodexCapacityTelemetry["capacityClass"] {
  if (!capacity) return "unknown";
  if (capacity.kind !== "available") return capacity.kind;
  return capacity.remainingPercentage > floor ? "above-floor" : "at-or-below-floor";
}

function consumeManualAssignment(state: CodexRoutingState, profile: string): void {
  if (state.next?.profile !== profile) return;
  state.next.remaining--;
  if (state.next.remaining <= 0) state.next = undefined;
}

function isProfileStore(value: ProviderFailure | CodexProfileStore | undefined): value is CodexProfileStore {
  return Boolean(value && "registryFile" in value);
}

function conservativeUsage(reservedTokens?: number): CodexUsage {
  const totalTokens = reservedTokens ?? 0;
  return { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens };
}

function addUsage(target: CodexUsage, usage: CodexUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}
