import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  codexProfileStore,
  readCodexRoutingState,
  updateCodexRoutingState,
  writeCodexProfiles,
  type CodexProfile,
} from "../src/codex-profiles.js";
import {
  readCapacities,
  recordActiveCapacityExhaustion,
  releaseCodexProfile,
  reserveCodexProfile,
  resolveUnfinishedReservations,
} from "../src/codex-router.js";

function assignment(result: Awaited<ReturnType<typeof reserveCodexProfile>>) {
  if (result.status !== "assigned") throw new Error(`expected assignment, received ${result.status}`);
  return result.assignment;
}

function store() {
  const root = mkdtempSync(join(tmpdir(), "sigil-profiles-"));
  mkdirSync(root, { recursive: true });
  return codexProfileStore(root);
}

function profile(name: string, remainingClass: "subscription" | "metered-api" = "subscription"): CodexProfile {
  return {
    name,
    home: `/codex/${name}`,
    enabled: true,
    profileClass: remainingClass,
    meteredMode: remainingClass === "metered-api" ? "overflow" : undefined,
  };
}

describe("Codex profile routing", () => {
  test("reserves the subscription with the greatest remaining percentage", async () => {
    const files = store();
    await writeCodexProfiles([profile("a"), profile("b")], files);

    const assignment = await reserveCodexProfile(async (entry) => ({
      available: true,
      remainingPercentage: entry.name === "a" ? 25 : 70,
    }), files);

    expect(assignment.status).toBe("assigned");
    expect(assignment.status === "assigned" && assignment.assignment.profile.name).toBe("b");
    expect((await readCodexRoutingState(files)).ledgers.b?.active).toBe(1);
  });

  test("holds an immutable reservation until agent close", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("only"), concurrencyLimit: 1 }], files);
    const capacity = async () => ({ available: true, remainingPercentage: 50 });

    const first = await reserveCodexProfile(capacity, files);
    const blocked = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(assignment(first).reservation.id, undefined, files);
    const later = await reserveCodexProfile(capacity, files);

    expect(blocked.status).toBe("capacity-blocked");
    expect(assignment(later).profile.name).toBe("only");
  });

  test("uses bounded metered overflow only after subscriptions are unavailable", async () => {
    const files = store();
    await writeCodexProfiles([
      profile("subscription"),
      { ...profile("api", "metered-api"), budget: { startLimit: 1, tokenLimit: 100 } },
    ], files);
    const unavailable = async () => ({ available: false });

    const overflow = await reserveCodexProfile(unavailable, files);
    await releaseCodexProfile(assignment(overflow).reservation.id, undefined, files);
    const exhausted = await reserveCodexProfile(unavailable, files);

    expect(assignment(overflow).profile.name).toBe("api");
    expect(exhausted.status).toBe("capacity-blocked");
    expect((await readCodexRoutingState(files)).ledgers.api?.usage.totalTokens).toBe(100);
  });

  test("serializes normal concurrent reservations without lock failures", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("parallel"), concurrencyLimit: 12 }], files);

    const assignments = await Promise.all(Array.from({ length: 12 }, () => reserveCodexProfile(
      async () => ({ available: true, remainingPercentage: 80 }),
      files,
    )));

    expect(assignments.every((entry) => entry.status === "assigned" && entry.assignment.profile.name === "parallel")).toBe(true);
    expect((await readCodexRoutingState(files)).ledgers.parallel?.active).toBe(12);
  });

  test("isolates failed subscription capacity reads and never probes API profiles", async () => {
    const files = store();
    const profiles = [profile("bad"), profile("good"), profile("api", "metered-api")];
    const calls: string[] = [];
    await writeCodexProfiles(profiles, files);

    const capacities = await readCapacities(profiles, async (entry) => {
      calls.push(entry.name);
      if (entry.name === "bad") throw new Error("unreachable");
      return { available: true, remainingPercentage: 60 };
    });

    expect(calls.sort()).toEqual(["bad", "good"]);
    expect(capacities.get("bad")?.kind).toBe("unknown");
    const good = capacities.get("good");
    expect(good?.kind).toBe("available");
    expect(good?.kind === "available" && good.remainingPercentage).toBe(60);
  });

  test("manual next-N can select a manual metered profile", async () => {
    const files = store();
    await writeCodexProfiles([
      profile("subscription"),
      { ...profile("api", "metered-api"), meteredMode: "manual", budget: { startLimit: 3 } },
    ], files);
    await updateCodexRoutingState((state) => {
      state.next = { profile: "api", remaining: 2 };
    }, files);

    const capacity = async () => ({ available: true, remainingPercentage: 90 });
    const first = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(assignment(first).reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
    const second = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(assignment(second).reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
    const automatic = await reserveCodexProfile(capacity, files);

    expect([assignment(first).profile.name, assignment(second).profile.name, assignment(automatic).profile.name]).toEqual(["api", "api", "subscription"]);
  });

  test("keeps a live metered reservation active during reconciliation", async () => {
    const files = store();
    await writeCodexProfiles([{
      ...profile("api", "metered-api"),
      budget: { tokenLimit: 100, requireRearm: true },
    }], files);
    const unavailable = async () => ({ available: false });

    const first = await reserveCodexProfile(unavailable, files);
    const blocked = await reserveCodexProfile(unavailable, files);
    await resolveUnfinishedReservations(files);
    const state = await readCodexRoutingState(files);

    expect(assignment(first).reservation.reservedTokens).toBe(100);
    expect(blocked.status).toBe("capacity-blocked");
    expect(state.ledgers.api?.usage.totalTokens).toBe(0);
    expect(state.ledgers.api?.active).toBe(1);
  });

  test("reserves subscription headroom without crossing the reserve floor", async () => {
    const files = store();
    await writeCodexProfiles([{
      ...profile("limited"),
      concurrencyLimit: 3,
      percentageQuantum: 20,
      reserveFloorPercentage: 20,
    }], files);
    const capacity = async () => ({ available: true, remainingPercentage: 60 });

    const first = await reserveCodexProfile(capacity, files);
    const second = await reserveCodexProfile(capacity, files);
    const blocked = await reserveCodexProfile(capacity, files);

    expect(first.status).toBe("assigned");
    expect(second.status).toBe("assigned");
    expect(blocked.status).toBe("capacity-blocked");
    expect(blocked.telemetry).toEqual([{
      profile: "limited",
      capacityClass: "above-floor",
      configuredFloor: 20,
      admissionOutcome: "blocked",
      capacityTriggeredCancellation: false,
    }]);
  });

  test("active exhaustion opens the capacity circuit and honors required rearm", async () => {
    const files = store();
    await writeCodexProfiles([{
      ...profile("protected"),
      reserveFloorPercentage: 20,
      requireRearmOnCapacityExhaustion: true,
    }], files);
    const first = assignment(await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), files));

    const recorded = await recordActiveCapacityExhaustion(
      first.reservation.id,
      new Date().toISOString(),
      files,
    );
    await releaseCodexProfile(first.reservation.id, undefined, files);

    expect(recorded).toBe(true);
    expect((await readCodexRoutingState(files)).circuits.protected?.reason).toBe("capacity");
    expect((await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), files)).status).toBe("capacity-blocked");

    await updateCodexRoutingState((state) => {
      state.ledgers.protected!.rearmRequired = false;
    }, files);
    expect((await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), files)).status).toBe("assigned");
  });

  test("stale and unknown observations fail closed without consuming manual next", async () => {
    const files = store();
    await writeCodexProfiles([profile("only")], files);
    await updateCodexRoutingState((state) => { state.next = { profile: "only", remaining: 1 }; }, files);
    const stale = await reserveCodexProfile(async () => ({
      kind: "available",
      available: true,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      remainingPercentage: 90,
    }), files);
    const unknown = await reserveCodexProfile(async () => ({
      kind: "unknown",
      available: false,
      observedAt: new Date().toISOString(),
    }), files);

    expect(stale.status).toBe("capacity-blocked");
    expect(unknown.status).toBe("capacity-blocked");
    expect((await readCodexRoutingState(files)).next?.remaining).toBe(1);
  });

  test("invalid persisted configuration fails closed before routing", async () => {
    const files = store();
    const invalid = profile("invalid");
    invalid.home = "";
    await Bun.write(files.registryFile, JSON.stringify({ version: 1, profiles: [invalid] }));
    chmodSync(files.registryFile, 0o600);

    await expect(reserveCodexProfile(
      async () => ({ available: true, remainingPercentage: 90 }),
      files,
    )).rejects.toMatchObject({ code: "corrupt" });
  });

  test("migrates ownerless reservations written by the previous routing state schema", async () => {
    const files = store();
    const startedAt = new Date().toISOString();
    await writeCodexProfiles([{
      ...profile("pro", "metered-api"),
      budget: { tokenLimit: 100, reservationTokens: 25, requireRearm: true },
    }], files);
    mkdirSync(dirname(files.stateFile), { recursive: true });
    writeFileSync(files.stateFile, JSON.stringify({
      version: 2,
      state: {
        roundRobin: 1,
        reservations: {
          legacy: {
            id: "legacy",
            profile: "pro",
            startedAt,
            reservedTokens: 25,
            unresolved: true,
          },
        },
        ledgers: {
          pro: {
            starts: 1,
            active: 1,
            reservedTokens: 25,
            runtimeMs: 0,
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
            },
            rearmRequired: false,
          },
        },
        circuits: {},
        unavailableProfiles: {},
      },
    }));
    chmodSync(files.stateFile, 0o600);

    const state = await readCodexRoutingState(files);

    expect(state.reservations).toEqual({});
    expect(state.ledgers.pro?.active).toBe(0);
    expect(state.ledgers.pro?.reservedTokens).toBe(0);
    expect(state.ledgers.pro?.usage.totalTokens).toBe(25);
    expect(state.ledgers.pro?.rearmRequired).toBe(true);
  });

  test("clears obsolete rearm state when a subscription policy does not require it", async () => {
    const files = store();
    await writeCodexProfiles([profile("pro")], files);
    mkdirSync(dirname(files.stateFile), { recursive: true });
    writeFileSync(files.stateFile, JSON.stringify({
      version: 2,
      state: {
        roundRobin: 1,
        reservations: {},
        ledgers: {
          pro: {
            starts: 1,
            active: 0,
            reservedTokens: 0,
            runtimeMs: 0,
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
            },
            rearmRequired: true,
          },
        },
        circuits: {},
        unavailableProfiles: {},
      },
    }));
    chmodSync(files.stateFile, 0o600);

    const admission = await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), files);
    const state = await readCodexRoutingState(files);

    expect(admission.status).toBe("assigned");
    expect(state.ledgers.pro?.rearmRequired).toBe(false);
  });
});
