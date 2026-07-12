import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

describe("codex-profile CLI", () => {
  test("status explains admission while redacting profile homes and account identity", () => {
    const home = mkdtempSync(join(tmpdir(), "sigil-profile-cli-"));
    const profileDir = join(home, "codex-profiles");
    const secretHome = "/private/account/home";
    const accountIdentity = "secret@example.test";
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "registry.json"), JSON.stringify({
      version: 1,
      profiles: [{
        name: "primary",
        home: secretHome,
        enabled: true,
        profileClass: "subscription",
        percentageQuantum: 10,
        reserveFloorPercentage: 20,
      }],
    }));
    writeFileSync(join(profileDir, "routing-state.json"), JSON.stringify({
      version: 2,
      state: {
        roundRobin: 0,
        reservations: {
          active: {
            id: "active", profile: "primary", startedAt: new Date().toISOString(), unresolved: true,
            observedAt: new Date().toISOString(), observedRemainingPercentage: 70,
            reservedHeadroomPercentage: 10,
          },
        },
        ledgers: {},
        circuits: { primary: { reason: "transient", openedAt: new Date().toISOString(), failures: 1, fingerprint: accountIdentity } },
        unavailableProfiles: {},
      },
    }));

    const result = spawnSync(
      process.execPath,
      ["src/cli.ts", "codex-profile", "status"],
      { cwd: process.cwd(), env: { ...process.env, SIGIL_HOME: home }, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("primary");
    expect(result.stdout).not.toContain(secretHome);
    expect(result.stdout).not.toContain('"home"');
    expect(result.stdout).toContain('"reserveFloorPercentage": 20');
    expect(result.stdout).toContain('"reservedHeadroomPercentage": 10');
    expect(result.stdout).toContain('"activeAssignments": 1');
    expect(result.stdout).toContain('"remainingCapacityClass": "above-floor"');
    expect(result.stdout).toContain('"reason": "transient"');
    expect(result.stdout).toContain('"state": "tracking"');
    expect(result.stdout).not.toContain(accountIdentity);
  });

  test("rearm clears circuit state without changing active reservation accounting", () => {
    const home = mkdtempSync(join(tmpdir(), "sigil-profile-rearm-"));
    const profileDir = join(home, "codex-profiles");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "routing-state.json"), JSON.stringify({ version: 2, state: {
      roundRobin: 0,
      reservations: { live: { id: "live", profile: "primary", startedAt: new Date().toISOString(), reservedTokens: 25, unresolved: true } },
      ledgers: { primary: { starts: 4, active: 1, reservedTokens: 25, runtimeMs: 50, usage: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 7 }, rearmRequired: true } },
      circuits: { primary: { reason: "authentication", openedAt: new Date().toISOString() } }, unavailableProfiles: {},
    } }));
    const result = spawnSync(process.execPath, ["src/cli.ts", "codex-profile", "rearm", "primary"], {
      cwd: process.cwd(), env: { ...process.env, SIGIL_HOME: home }, encoding: "utf8",
    });
    const state = JSON.parse(readFileSync(join(profileDir, "routing-state.json"), "utf8")).state;
    expect(result.status).toBe(0);
    expect(state.reservations.live.reservedTokens).toBe(25);
    expect(state.ledgers.primary).toMatchObject({ starts: 4, active: 1, reservedTokens: 25, runtimeMs: 50, rearmRequired: false });
    expect(state.circuits.primary).toBeUndefined();
  });

  test("rejects reserve floors outside zero through one hundred", () => {
    const result = spawnSync(process.execPath, ["src/cli.ts", "codex-profile", "add", "bad", "--home", "/tmp", "--reserve-floor", "101"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status).toBe(2);
  });
});
