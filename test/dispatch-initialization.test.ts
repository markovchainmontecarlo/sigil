import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { DEFAULT_SIGIL_CONFIG } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { CodexProfile } from "../src/codex-profiles.js";
import { initializeDispatchProfiles } from "../src/workflows/dispatch/initialization.js";

function profile(name: string, profileClass: CodexProfile["profileClass"]): CodexProfile {
  return {
    name,
    home: join(tmpdir(), name),
    enabled: true,
    profileClass,
  };
}

describe("dispatch initialization", () => {
  test("reconciles assignments and primes enabled subscription profiles", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-dispatch-initialization-"));
    const ctx = createContext(repo);
    const primed: string[] = [];
    let reconciled = false;

    await initializeDispatchProfiles(ctx, DEFAULT_SIGIL_CONFIG, {
      resolveReservations: async () => { reconciled = true; },
      readProfiles: async () => [
        profile("active", "subscription"),
        profile("dormant", "subscription"),
        profile("api", "metered-api"),
      ],
      primeProfile: async (candidate) => {
        primed.push(candidate.name);
        return {
          before: { profileClass: "subscription", capacity: { kind: "unavailable", available: false, observedAt: new Date().toISOString() } },
          after: { profileClass: "subscription", capacity: { kind: "unavailable", available: false, observedAt: new Date().toISOString() } },
          windowStarted: candidate.name === "dormant",
        };
      },
    });

    const artifact = JSON.parse(readFileSync(
      ctx.artifacts.path("dispatch-initialization/codex-profile-priming.json"),
      "utf8",
    )) as { results: Array<{ profile: string; outcome: string }> };

    expect(reconciled).toBe(true);
    expect(primed).toEqual(["active", "dormant"]);
    expect(artifact.results).toEqual([
      { profile: "active", outcome: "active" },
      { profile: "dormant", outcome: "primed" },
    ]);
  });
});
