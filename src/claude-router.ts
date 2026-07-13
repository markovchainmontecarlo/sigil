import { randomUUID } from "node:crypto";

import type { AgentBinding } from "./config.js";
import type { AgentOptions, AgentRuntimeMetadata, SigilAgent } from "./agents.js";
import { createClaudeAgentFromGenerate } from "./agents.js";
import { createClaudePtyAgent } from "./claude-pty.js";
import {
  claudeProfileStore,
  readClaudeProfiles,
  readClaudeRoutingState,
  resolveClaudeCredentialSource,
  updateClaudeRoutingState,
  type ClaudeProfile,
  type ClaudeProfileStore,
} from "./claude-profiles.js";
import { createClaudeSdkGenerate, type ClaudeObservedUsage } from "./claude-sdk.js";
import { classifyProviderFailure, ProviderError, type ProviderFailure } from "./provider-failure.js";
import { processIdentityStatus, readProcessIdentity } from "./process-identity.js";

export type ClaudeAssignment = { profile: ClaudeProfile; reservationId: string; routingReason: string };

export function createRoutedClaudeAgent(binding: AgentBinding, cwd: string, options: AgentOptions): SigilAgent {
  let assignmentPromise: Promise<{ agent: SigilAgent; assignment: ClaudeAssignment }> | undefined;
  let failure: ProviderFailure | undefined;
  let usage: ClaudeObservedUsage | undefined;
  let closed = false;
  const runtime: AgentRuntimeMetadata = { binding: `claude:${binding.model}`, provider: "claude" };

  const assigned = () => assignmentPromise ??= assignClaude(binding, cwd, options, runtime);
  const prompt = async <T>(text: string, schema?: import("zod").z.ZodType<T>, promptOptions?: import("./agents.js").AgentPromptOptions): Promise<string | T> => {
    if (closed) throw new Error("agent is closed");
    const active = await assigned();
    try {
      return schema
        ? await active.agent.promptWithOptions?.(text, schema, promptOptions ?? {}) ?? active.agent.prompt(text, schema)
        : await active.agent.promptWithOptions?.(text, undefined, promptOptions ?? {}) ?? active.agent.prompt(text) as Promise<string>;
    } catch (error) {
      failure = classifyProviderFailure(error);
      throw error;
    }
  };

  return {
    prompt: prompt as SigilAgent["prompt"],
    promptWithOptions: prompt,
    async close() {
      if (closed) return;
      closed = true;
      if (!assignmentPromise) return;
      const active = await assignmentPromise;
      const errors: unknown[] = [];
      try {
        await active.agent.close();
      } catch (error) {
        errors.push(error);
      } finally {
        usage = runtime.usage as ClaudeObservedUsage | undefined;
        try {
          await releaseClaude(active.assignment, usage, failure, options.claudeProfileStore);
        } catch (error) {
          errors.push(error);
        }
        runtime.active = false;
        await options.onRuntimeUpdate?.(runtime);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Claude agent cleanup failed");
    },
    async [Symbol.asyncDispose]() { await this.close(); },
    runtime,
  };
}

async function assignClaude(binding: AgentBinding, cwd: string, options: AgentOptions, runtime: AgentRuntimeMetadata) {
  const assignment = await reserveClaude(options.claudeProfileStore);
  try {
    runtime.profile = assignment.profile.name;
    runtime.accessClass = assignment.profile.accessClass;
    runtime.transport = assignment.profile.accessClass === "subscription" ? "claude-cli-pty" : "claude-agent-sdk";
    runtime.routingReason = assignment.routingReason;
    runtime.active = true;
    await options.onRuntimeUpdate?.(runtime);
    const profile = assignment.profile;
    if (profile.accessClass === "subscription") {
      return { assignment, agent: createClaudePtyAgent(binding, cwd, profile, options, options.claudePtyDependencies, runtime) };
    }
    const credential = resolveClaudeCredentialSource(profile);
    if (!credential) throw new ProviderError("Claude credential source is unresolved", { code: "credential_unresolved" });
    const generate = createClaudeSdkGenerate(binding, cwd, profile, credential);
    const agent = createClaudeAgentFromGenerate(async <T>(text: string, promptOptions?: Record<string, unknown>) => {
      const result = await generate<T>(text, promptOptions);
      runtime.usage = result.usage;
      await options.onRuntimeUpdate?.(runtime);
      return result;
    });
    Object.defineProperty(agent, "runtime", { value: runtime });
    return { assignment, agent };
  } catch (error) {
    await releaseClaude(assignment, undefined, classifyProviderFailure(error), options.claudeProfileStore);
    runtime.active = false;
    await options.onRuntimeUpdate?.(runtime);
    throw error;
  }
}

export async function reserveClaude(store: ClaudeProfileStore = claudeProfileStore()): Promise<ClaudeAssignment> {
  const profiles = await readClaudeProfiles(store);
  const owner = await readProcessIdentity();
  return updateClaudeRoutingState(async (state) => {
    await reconcileClaudeReservations(state);
    const eligible = profiles.filter((profile) => profile.enabled)
      .filter((profile) => !state.circuits[profile.name])
      .filter((profile) => (state.ledgers[profile.name]?.active ?? 0) < (profile.concurrencyLimit ?? Infinity));
    const selected = consumeNextClaudeProfile(profiles, state, eligible);
    const subscriptions = eligible.filter((profile) => profile.accessClass === "subscription");
    const metered = eligible.filter((profile) => profile.accessClass === "metered-api")
      .filter((profile) => profile.mode === "automatic" || profile.mode === "overflow")
      .filter((profile) => withinBudget(profile, state.ledgers[profile.name]));
    const profile = selected ?? subscriptions[0] ?? metered[0];
    if (!profile) throw new ProviderError("Claude profile capacity is unavailable", { code: "capacity_exhausted" });
    const reservationId = randomUUID();
    state.reservations[reservationId] = { profile: profile.name, owner, startedAt: new Date().toISOString(), reservedUsd: profile.operation?.usdLimit };
    const ledger = state.ledgers[profile.name] ??= { starts: 0, active: 0, spentUsd: 0 };
    ledger.starts += 1;
    ledger.active += 1;
    ledger.reservedUsd = (ledger.reservedUsd ?? 0) + (profile.operation?.usdLimit ?? 0);
    return { profile, reservationId, routingReason: selected ? "one-shot" : subscriptions.length ? "subscription-preferred" : "metered-fallback" };
  }, store);
}

export async function reconcileClaudeRoutingState(
  store: ClaudeProfileStore = claudeProfileStore(),
): Promise<void> {
  await updateClaudeRoutingState(reconcileClaudeReservations, store);
}

async function releaseClaude(assignment: ClaudeAssignment, usage: ClaudeObservedUsage | undefined, failure: ProviderFailure | undefined, store?: ClaudeProfileStore) {
  await updateClaudeRoutingState((state) => {
    const reservation = state.reservations[assignment.reservationId];
    if (!reservation) return;
    const ledger = state.ledgers[assignment.profile.name];
    if (ledger) {
      ledger.active = Math.max(0, ledger.active - 1);
      ledger.reservedUsd = Math.max(0, (ledger.reservedUsd ?? 0) - (reservation.reservedUsd ?? 0));
      ledger.spentUsd += usage?.costUsd ?? 0;
    }
    delete state.reservations[assignment.reservationId];
    if (failure?.code === "authentication_failed") state.circuits[assignment.profile.name] = { reason: "authentication", openedAt: new Date().toISOString() };
  }, store);
}

function withinBudget(profile: ClaudeProfile, ledger?: { starts: number; spentUsd: number; reservedUsd?: number }): boolean {
  if (profile.accessClass !== "metered-api" || !profile.operation?.usdLimit || !profile.admission) return false;
  if (profile.admission.startLimit !== undefined && (ledger?.starts ?? 0) >= profile.admission.startLimit) return false;
  if (profile.admission.usdLimit !== undefined && (ledger?.spentUsd ?? 0) + (ledger?.reservedUsd ?? 0) + profile.operation.usdLimit > profile.admission.usdLimit) return false;
  return true;
}

async function reconcileClaudeReservations(state: import("./claude-profiles.js").ClaudeRoutingState): Promise<void> {
  for (const [id, reservation] of Object.entries(state.reservations)) {
    const status = await processIdentityStatus(reservation.owner);
    if (status === "match") continue;
    const ledger = state.ledgers[reservation.profile];
    if (ledger) {
      ledger.active = Math.max(0, ledger.active - 1);
      ledger.reservedUsd = Math.max(0, (ledger.reservedUsd ?? 0) - (reservation.reservedUsd ?? 0));
    }
    delete state.reservations[id];
  }
}

function consumeNextClaudeProfile(
  profiles: ClaudeProfile[],
  state: import("./claude-profiles.js").ClaudeRoutingState,
  eligible: ClaudeProfile[],
): ClaudeProfile | undefined {
  if (!state.next) return undefined;
  const profile = profiles.find((entry) => entry.name === state.next?.profile);
  const budgetEligible = profile?.accessClass === "subscription"
    || (profile ? withinBudget(profile, state.ledgers[profile.name]) : false);
  if (!profile || !eligible.includes(profile) || !budgetEligible) {
    throw new ProviderError("Selected Claude profile is unavailable", { code: "capacity_exhausted" });
  }
  state.next.remaining -= 1;
  if (state.next.remaining === 0) delete state.next;
  return profile;
}
