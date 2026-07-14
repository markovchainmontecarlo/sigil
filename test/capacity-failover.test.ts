import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { runFreshAgentOperation } from "../src/agent-operation.js";
import { codexProfileStore, readCodexRoutingState, writeCodexProfiles, type CodexProfile } from "../src/codex-profiles.js";
import { releaseCodexProfile, reserveCodexProfile } from "../src/codex-router.js";
import { classifyProviderFailure, ProviderError } from "../src/provider-failure.js";
import type { RichSigilAgent, SigilContext } from "../src/context.js";

const capacity = (remainingPercentage: number) => async () => ({ available: true, remainingPercentage });
const profile = (name: string): CodexProfile => ({ name, home: `/codex/${name}`, enabled: true, profileClass: "subscription", reserveFloorPercentage: 20 });
function assigned(result: Awaited<ReturnType<typeof reserveCodexProfile>>) {
  if (result.status !== "assigned") throw new Error(`expected assignment, got ${result.status}`);
  return result.assignment;
}

describe("capacity failover", () => {
  test("active floor exhaustion closes the failed child before capacity failover without spending repair budget", async () => {
    const events: string[] = [];
    const profiles = ["a", "b"];
    const ctx = {
      repo: process.cwd(),
      async withAgent(_binding: unknown, fn: (agent: RichSigilAgent) => Promise<unknown>) {
        const selected = profiles.shift()!;
        events.push(`start:${selected}`);
        const agent = { runtime: { profile: selected }, close: async () => {}, prompt: async () => "" } as unknown as RichSigilAgent;
        try { return await fn(agent); } finally { events.push(`close:${selected}`); }
      },
      observe: async () => {},
    } as unknown as SigilContext;
    const result = await runFreshAgentOperation(ctx, { provider: "codex", model: "test" }, {
      stage: "scripted", limit: 0, timeoutMs: 1_000,
    }, async (agent) => {
      if (agent.runtime?.profile === "a") {
        throw new ProviderError("capacity floor reached", {
          code: "capacity_exhausted",
          account: "a",
        });
      }
      return agent.runtime?.profile;
    });

    expect(result).toMatchObject({ ok: true, value: "b", attempts: 1 });
    expect(events).toEqual(["start:a", "close:a", "start:b", "close:b"]);
  });

  test("authentication is terminal and transient failures remain operation-local", async () => {
    const store = codexProfileStore(mkdtempSync(join(tmpdir(), "sigil-failover-")));
    await writeCodexProfiles([profile("a")], store);
    const auth = assigned(await reserveCodexProfile(capacity(80), store));
    await releaseCodexProfile(auth.reservation.id, undefined, classifyProviderFailure(new ProviderError("auth", { code: "authentication_failed" })), store);
    expect((await readCodexRoutingState(store)).circuits.a?.reason).toBe("authentication");

    await Bun.write(store.stateFile, JSON.stringify({ version: 2, state: { roundRobin: 0, reservations: {}, ledgers: {}, circuits: {}, unavailableProfiles: {} } }));
    const admission = assigned(await reserveCodexProfile(capacity(80), store));
    await releaseCodexProfile(admission.reservation.id, undefined, classifyProviderFailure(new ProviderError("temporary", { code: "transient" })), store);

    expect((await readCodexRoutingState(store)).circuits.a).toBeUndefined();
  });

  test("only a fresh above-floor probe automatically closes a capacity circuit", async () => {
    const store = codexProfileStore(mkdtempSync(join(tmpdir(), "sigil-probe-")));
    await writeCodexProfiles([profile("a")], store);
    const first = assigned(await reserveCodexProfile(capacity(80), store));
    await releaseCodexProfile(first.reservation.id, undefined, classifyProviderFailure(new ProviderError("full", { code: "capacity_exhausted" })), store);
    expect((await reserveCodexProfile(capacity(10), store)).status).toBe("capacity-blocked");
    expect((await reserveCodexProfile(capacity(40), store)).status).toBe("assigned");
  });
});
