import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  codexProfileStore,
  readCodexRoutingState,
  updateCodexRoutingState,
  writeCodexProfiles,
  type CodexProfile,
} from "../src/codex-profiles.js";
import { readCapacities, releaseCodexProfile, reserveCodexProfile, resolveUnfinishedReservations } from "../src/codex-router.js";

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

    expect(assignment?.profile.name).toBe("b");
    expect((await readCodexRoutingState(files)).ledgers.b?.active).toBe(1);
  });

  test("holds an immutable reservation until agent close", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("only"), concurrencyLimit: 1 }], files);
    const capacity = async () => ({ available: true, remainingPercentage: 50 });

    const first = await reserveCodexProfile(capacity, files);
    const blocked = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(first!.reservation.id, undefined, files);
    const later = await reserveCodexProfile(capacity, files);

    expect(blocked).toBeUndefined();
    expect(later?.profile.name).toBe("only");
  });

  test("uses bounded metered overflow only after subscriptions are unavailable", async () => {
    const files = store();
    await writeCodexProfiles([
      profile("subscription"),
      { ...profile("api", "metered-api"), budget: { startLimit: 1, tokenLimit: 100 } },
    ], files);
    const unavailable = async () => ({ available: false });

    const overflow = await reserveCodexProfile(unavailable, files);
    await releaseCodexProfile(overflow!.reservation.id, undefined, files);
    const exhausted = await reserveCodexProfile(unavailable, files);

    expect(overflow?.profile.name).toBe("api");
    expect(exhausted).toBeUndefined();
    expect((await readCodexRoutingState(files)).ledgers.api?.usage.totalTokens).toBe(100);
  });

  test("serializes normal concurrent reservations without lock failures", async () => {
    const files = store();
    await writeCodexProfiles([{ ...profile("parallel"), concurrencyLimit: 12 }], files);

    const assignments = await Promise.all(Array.from({ length: 12 }, () => reserveCodexProfile(
      async () => ({ available: true, remainingPercentage: 80 }),
      files,
    )));

    expect(assignments.every((entry) => entry?.profile.name === "parallel")).toBe(true);
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
    expect(capacities.get("bad")).toEqual({ available: false });
    expect(capacities.get("good")?.remainingPercentage).toBe(60);
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
    await releaseCodexProfile(first!.reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
    const second = await reserveCodexProfile(capacity, files);
    await releaseCodexProfile(second!.reservation.id, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }, files);
    const automatic = await reserveCodexProfile(capacity, files);

    expect([first?.profile.name, second?.profile.name, automatic?.profile.name]).toEqual(["api", "api", "subscription"]);
  });

  test("reserves remaining metered tokens and conservatively charges unresolved work", async () => {
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

    expect(first?.reservation.reservedTokens).toBe(100);
    expect(blocked).toBeUndefined();
    expect(state.ledgers.api?.usage.totalTokens).toBe(100);
    expect(state.ledgers.api?.rearmRequired).toBe(true);
  });
});
