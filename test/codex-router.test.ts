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
  releaseCodexProfile,
  reserveCodexProfile,
  resolveUnfinishedReservations,
} from "../src/codex-router.js";

function assignment(result: Awaited<ReturnType<typeof reserveCodexProfile>>) {
  if (result.status !== "assigned") throw new Error(`expected assignment, received ${result.status}`);
  return result.assignment;
}

function meteredAssignment(result: Awaited<ReturnType<typeof reserveCodexProfile>>) {
  const selected = assignment(result);
  if (!selected.reservation) throw new Error("expected metered reservation");
  return { ...selected, reservation: selected.reservation };
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
  test("selects subscriptions round-robin without probing capacity", async () => {
    const files = store();
    await writeCodexProfiles([profile("a"), profile("b")], files);
    let probes = 0;

    const first = await reserveCodexProfile(async () => {
      probes++;
      return { available: false };
    }, files);
    const second = await reserveCodexProfile(async () => {
      probes++;
      return { available: false };
    }, files);

    expect(assignment(first).profile.name).toBe("a");
    expect(assignment(second).profile.name).toBe("b");
    expect(probes).toBe(0);
    expect((await readCodexRoutingState(files)).reservations).toEqual({});
  });

  test("subscription assignment does not create accounting state", async () => {
    const files = store();
    await writeCodexProfiles([profile("subscription")], files);
    const admission = await reserveCodexProfile(
      async () => ({ available: true, remainingPercentage: 80 }),
      files,
    );

    const state = await readCodexRoutingState(files);

    expect(assignment(admission).reservation).toBeUndefined();
    expect(state.ledgers.subscription).toBeUndefined();
  });

  test("does not enforce subscription concurrency locally", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("only"), concurrencyLimit: 1 }], files);
    const capacity = async () => ({ available: true, remainingPercentage: 50 });

    const first = await reserveCodexProfile(capacity, files);
    const second = await reserveCodexProfile(capacity, files);

    expect(assignment(first).profile.name).toBe("only");
    expect(assignment(second).profile.name).toBe("only");
    expect((await readCodexRoutingState(files)).reservations).toEqual({});
  });

  test("does not select metered overflow while an enabled subscription exists", async () => {
    const files = store();
    await writeCodexProfiles([
      profile("subscription"),
      { ...profile("api", "metered-api"), budget: { startLimit: 1, tokenLimit: 100 } },
    ], files);
    const unavailable = async () => ({ available: false });

    const selected = await reserveCodexProfile(unavailable, files);

    expect(assignment(selected).profile.name).toBe("subscription");
    expect((await readCodexRoutingState(files)).ledgers.api).toBeUndefined();
  });

  test("selects concurrent subscription agents without reservations", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("parallel"), concurrencyLimit: 12 }], files);

    const assignments = await Promise.all(Array.from({ length: 12 }, () => reserveCodexProfile(
      async () => ({ available: true, remainingPercentage: 80 }),
      files,
    )));

    expect(assignments.every((entry) => entry.status === "assigned" && entry.assignment.profile.name === "parallel")).toBe(true);
    expect((await readCodexRoutingState(files)).reservations).toEqual({});
  });

  test("holds the routing-state lock until an asynchronous update completes", async () => {
    const files = store();
    let releaseFirst!: () => void;
    let secondEntered = false;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = updateCodexRoutingState(async (state) => {
      state.roundRobin = 1;
      await firstCanFinish;
    }, files);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = updateCodexRoutingState((state) => {
      secondEntered = true;
      state.roundRobin++;
    }, files);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect((await readCodexRoutingState(files)).roundRobin).toBe(2);
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
    await releaseCodexProfile(meteredAssignment(first).reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
    const second = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(meteredAssignment(second).reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
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

    expect(meteredAssignment(first).reservation.reservedTokens).toBe(100);
    expect(blocked.status).toBe("capacity-blocked");
    expect(state.ledgers.api?.metered?.usage.totalTokens).toBe(0);
    expect(state.ledgers.api?.active).toBe(1);
  });

  test("ignores subscription capacity floors and percentage reservations", async () => {
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
    expect(blocked.status).toBe("assigned");
    expect((await readCodexRoutingState(files)).reservations).toEqual({});
  });

  test("subscription capacity does not create a persistent circuit", async () => {
    const files = store();
    await writeCodexProfiles([{
      ...profile("protected"),
      reserveFloorPercentage: 20,
      requireRearmOnCapacityExhaustion: true,
    }], files);
    const selected = await reserveCodexProfile(async () => ({ available: false }), files);

    expect(selected.status).toBe("assigned");
    expect((await readCodexRoutingState(files)).circuits.protected).toBeUndefined();
  });

  test("stale and unknown observations do not block explicit subscription selection", async () => {
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

    expect(stale.status).toBe("assigned");
    expect(unknown.status).toBe("assigned");
    expect((await readCodexRoutingState(files)).next).toBeUndefined();
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
    expect(state.ledgers.pro?.metered?.reservedTokens).toBe(0);
    expect(state.ledgers.pro?.metered?.usage.totalTokens).toBe(25);
    expect(state.ledgers.pro?.rearmRequired).toBe(true);
  });

  test("discards persisted subscription admission state", async () => {
    const files = store();
    await writeCodexProfiles([profile("subscription")], files);
    mkdirSync(dirname(files.stateFile), { recursive: true });
    writeFileSync(files.stateFile, JSON.stringify({
      version: 2,
      state: {
        roundRobin: 1,
        reservations: {
          stale: {
            id: "stale",
            profile: "subscription",
            owner: { pid: 999_999_999, startIdentity: "missing" },
            startedAt: new Date().toISOString(),
            reservedHeadroomPercentage: 10,
            unresolved: true,
          },
        },
        ledgers: {
          subscription: {
            starts: 1,
            active: 1,
            runtimeMs: 0,
            rearmRequired: true,
          },
        },
        circuits: {
          subscription: {
            reason: "capacity",
            openedAt: new Date().toISOString(),
          },
        },
        unavailableProfiles: {},
      },
    }));
    chmodSync(files.stateFile, 0o600);

    const state = await readCodexRoutingState(files);

    expect(state.reservations).toEqual({});
    expect(state.ledgers.subscription?.active).toBe(0);
    expect(state.ledgers.subscription?.rearmRequired).toBe(false);
    expect(state.circuits.subscription).toBeUndefined();
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
    expect(state.ledgers.pro).not.toHaveProperty("usage");
    expect(state.ledgers.pro).not.toHaveProperty("reservedTokens");
  });
});
