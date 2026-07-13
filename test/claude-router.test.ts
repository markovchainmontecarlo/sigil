import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  claudeProfileStore,
  readClaudeRoutingState,
  updateClaudeRoutingState,
  writeClaudeProfiles,
  type ClaudeProfile,
} from "../src/claude-profiles.js";
import { reserveClaude } from "../src/claude-router.js";

function store() {
  return claudeProfileStore(mkdtempSync(join(tmpdir(), "sigil-claude-router-")));
}

function metered(name: string, usdLimit: number, operationLimit: number): ClaudeProfile {
  return {
    provider: "claude",
    name,
    enabled: true,
    accessClass: "metered-api",
    mode: "automatic",
    admission: { usdLimit },
    operation: { usdLimit: operationLimit },
    details: { credentialSource: "CLAUDE_KEY" },
  };
}

describe("Claude profile routing", () => {
  test("active metered exposure prevents concurrent budget overcommit", async () => {
    const files = store();
    await writeClaudeProfiles([metered("api", 10, 6)], files);

    await reserveClaude(files);

    await expect(reserveClaude(files)).rejects.toMatchObject({ providerCode: "capacity_exhausted" });
    expect((await readClaudeRoutingState(files)).ledgers.api?.reservedUsd).toBe(6);
  });

  test("proven-stale reservations are reconciled before admission", async () => {
    const files = store();
    await writeClaudeProfiles([{ ...metered("api", 10, 5), concurrencyLimit: 1 }], files);
    await updateClaudeRoutingState((state) => {
      state.reservations.stale = {
        profile: "api",
        owner: { pid: 999_999_999, startIdentity: "missing" },
        startedAt: new Date().toISOString(),
        reservedUsd: 5,
      };
      state.ledgers.api = { starts: 1, active: 1, spentUsd: 0, reservedUsd: 5 };
    }, files);

    const assignment = await reserveClaude(files);
    const state = await readClaudeRoutingState(files);

    expect(assignment.profile.name).toBe("api");
    expect(state.reservations.stale).toBeUndefined();
    expect(state.ledgers.api).toMatchObject({ starts: 2, active: 1, reservedUsd: 5 });
  });

  test("one-shot selection is consumed before normal subscription routing", async () => {
    const files = store();
    const subscription: ClaudeProfile = {
      provider: "claude", name: "subscription", enabled: true, accessClass: "subscription",
      details: { configurationDirectory: join(tmpdir(), "claude") },
    };
    await writeClaudeProfiles([subscription, metered("api", 10, 1)], files);
    await updateClaudeRoutingState((state) => { state.next = { profile: "api", remaining: 1 }; }, files);

    const assignment = await reserveClaude(files);

    expect(assignment.profile.name).toBe("api");
    expect(assignment.routingReason).toBe("one-shot");
    expect((await readClaudeRoutingState(files)).next).toBeUndefined();
  });
});
