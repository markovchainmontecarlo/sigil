import {
  newReservation,
  profileLedger,
  readCodexProfiles,
  updateCodexRoutingState,
  type CodexProfile,
  type CodexProfileStore,
  type CodexRoutingState,
  type CodexUsage,
  type ProfileReservation,
} from "./codex-profiles.js";

export type SubscriptionCapacity = {
  remainingPercentage?: number;
  available: boolean;
};

export type CapacityReader = (profile: CodexProfile) => Promise<SubscriptionCapacity>;
export type CodexAssignment = { profile: CodexProfile; reservation: ProfileReservation };

export async function reserveCodexProfile(
  readCapacity: CapacityReader,
  store?: CodexProfileStore,
): Promise<CodexAssignment | undefined> {
  const profiles = await readCodexProfiles(store);
  const capacities = await readCapacities(profiles, readCapacity);

  return updateCodexRoutingState((state) => {
    const profile = selectProfile(profiles, capacities, state);
    if (!profile) return undefined;

    const reservation = reserveProfile(profile, capacities.get(profile.name), state);
    consumeManualAssignment(state, profile.name);
    return { profile, reservation };
  }, store);
}

export async function releaseCodexProfile(
  reservationId: string,
  usage: CodexUsage | undefined,
  store?: CodexProfileStore,
): Promise<void> {
  const profiles = await readCodexProfiles(store);
  await updateCodexRoutingState((state) => {
    const reservation = state.reservations[reservationId];
    if (!reservation) return;

    const profile = profiles.find((entry) => entry.name === reservation.profile);
    const ledger = profileLedger(state, reservation.profile);
    const charged = usage ?? conservativeUsage(reservation.reservedTokens);
    ledger.active = Math.max(0, ledger.active - 1);
    ledger.reservedTokens = Math.max(0, ledger.reservedTokens - (reservation.reservedTokens ?? 0));
    ledger.runtimeMs += Math.max(0, Date.now() - Date.parse(reservation.startedAt));
    addUsage(ledger.usage, charged);
    if (profile?.budget?.requireRearm) ledger.rearmRequired = true;
    delete state.reservations[reservationId];
  }, store);
}

export async function resolveUnfinishedReservations(
  store?: CodexProfileStore,
): Promise<void> {
  const profiles = await readCodexProfiles(store);
  await updateCodexRoutingState((state) => {
    for (const reservation of Object.values(state.reservations)) {
      const profile = profiles.find((entry) => entry.name === reservation.profile);
      const ledger = profileLedger(state, reservation.profile);
      const charged = conservativeUsage(reservation.reservedTokens);
      ledger.active = Math.max(0, ledger.active - 1);
      ledger.reservedTokens = Math.max(0, ledger.reservedTokens - (reservation.reservedTokens ?? 0));
      addUsage(ledger.usage, charged);
      if (profile?.budget?.requireRearm) ledger.rearmRequired = true;
      delete state.reservations[reservation.id];
    }
  }, store);
}

function selectProfile(
  profiles: CodexProfile[],
  capacities: Map<string, SubscriptionCapacity>,
  state: CodexRoutingState,
): CodexProfile | undefined {
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
  if (!profile.enabled) return false;
  if (atConcurrencyLimit(profile, state)) return false;
  return capacity?.available === true
    && capacity.remainingPercentage !== undefined
    && capacity.remainingPercentage > 0;
}

function eligibleMetered(profile: CodexProfile, state: CodexRoutingState): boolean {
  if (!profile.enabled) return false;
  const ledger = profileLedger(state, profile.name);
  if (atConcurrencyLimit(profile, state)) return false;
  if (ledger.rearmRequired) return false;
  if (profile.budget?.startLimit !== undefined && ledger.starts >= profile.budget.startLimit) return false;
  if (profile.budget?.runtimeLimitMs !== undefined && ledger.runtimeMs >= profile.budget.runtimeLimitMs) return false;
  return remainingTokenBudget(profile, state) !== 0;
}

function atConcurrencyLimit(profile: CodexProfile, state: CodexRoutingState): boolean {
  const ledger = profileLedger(state, profile.name);
  const limit = profile.budget?.concurrencyLimit ?? profile.concurrencyLimit;
  return limit !== undefined && ledger.active >= limit;
}

function reserveProfile(
  profile: CodexProfile,
  capacity: SubscriptionCapacity | undefined,
  state: CodexRoutingState,
): ProfileReservation {
  const reservedTokens = profile.profileClass === "metered-api"
    ? reservationTokenAmount(profile, state)
    : undefined;
  const reservation = newReservation(profile.name, {
    startingPercentage: capacity?.remainingPercentage,
    percentageQuantum: profile.percentageQuantum,
    reservedTokens,
  });
  const ledger = profileLedger(state, profile.name);
  ledger.active++;
  ledger.starts++;
  ledger.reservedTokens += reservedTokens ?? 0;
  state.reservations[reservation.id] = reservation;
  return reservation;
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
  const maximum = Math.max(...profiles.map((profile) => capacities.get(profile.name)?.remainingPercentage ?? -1));
  const tied = profiles
    .filter((profile) => capacities.get(profile.name)?.remainingPercentage === maximum)
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
      return [profile.name, await readCapacity(profile)] as const;
    } catch {
      return [profile.name, { available: false }] as const;
    }
  }));
  return new Map(entries);
}

function consumeManualAssignment(state: CodexRoutingState, profile: string): void {
  if (state.next?.profile !== profile) return;
  state.next.remaining--;
  if (state.next.remaining <= 0) state.next = undefined;
}

function conservativeUsage(reservedTokens?: number): CodexUsage {
  const totalTokens = reservedTokens ?? 0;
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
  };
}

function addUsage(target: CodexUsage, usage: CodexUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}
