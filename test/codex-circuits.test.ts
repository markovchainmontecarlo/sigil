import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  codexProfileStore,
  readCodexRoutingState,
  writeCodexProfiles,
  type CodexProfile,
} from "../src/codex-profiles.js";
import { releaseCodexProfile, reserveCodexProfile, resolveUnfinishedReservations } from "../src/codex-router.js";
import { classifyProviderFailure, ProviderError } from "../src/provider-failure.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sigil-circuit-"));
  mkdirSync(root, { recursive: true });
  return codexProfileStore(root);
}

const profile: CodexProfile = {
  name: "subscription",
  home: "/codex/subscription",
  enabled: true,
  profileClass: "subscription",
};

function assigned(result: Awaited<ReturnType<typeof reserveCodexProfile>>) {
  if (result.status !== "assigned") throw new Error(`expected assignment, received ${result.status}`);
  return result.assignment;
}

describe("Codex routing circuits", () => {
  test("release removes the reservation and persists a reason-specific circuit atomically", async () => {
    const store = fixture();
    await writeCodexProfiles([profile], store);
    const admission = await reserveCodexProfile(async () => ({ available: true, remainingPercentage: 80 }), store);
    const failure = classifyProviderFailure(new ProviderError("authentication failed", {
      code: "authentication_failed",
    }));

    await releaseCodexProfile(assigned(admission).reservation.id, undefined, failure, store);
    const state = await readCodexRoutingState(store);

    expect(state.reservations).toEqual({});
    expect(state.circuits.subscription?.reason).toBe("authentication");
  });

  test("a fresh healthy observation closes a capacity circuit", async () => {
    const store = fixture();
    await writeCodexProfiles([profile], store);
    const first = await reserveCodexProfile(async () => ({ available: true, remainingPercentage: 80 }), store);
    const failure = classifyProviderFailure(new ProviderError("capacity exhausted", {
      code: "capacity_exhausted",
    }));
    await releaseCodexProfile(assigned(first).reservation.id, undefined, failure, store);

    const next = await reserveCodexProfile(async () => ({ available: true, remainingPercentage: 70 }), store);

    expect(next.status).toBe("assigned");
    expect((await readCodexRoutingState(store)).circuits.subscription).toBeUndefined();
  });

  test("unsupported state versions fail closed", async () => {
    const store = fixture();
    await writeCodexProfiles([profile], store);
    await Bun.write(store.stateFile, JSON.stringify({
      version: 1,
      state: {
        roundRobin: 0,
        reservations: {
          old: { id: "old", profile: "subscription", startedAt: new Date().toISOString(), unresolved: true },
        },
        ledgers: {
          subscription: {
            starts: 3,
            active: 1,
            reservedTokens: 0,
            runtimeMs: 10,
            usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 5 },
            rearmRequired: false,
          },
        },
      },
    }));
    chmodSync(store.stateFile, 0o600);

    await expect(resolveUnfinishedReservations(store)).rejects.toMatchObject({ code: "unsupported-version" });
  });
});
