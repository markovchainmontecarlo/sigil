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

describe("Codex routing state", () => {
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
