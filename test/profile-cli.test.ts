import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const emptyCodexState = { version: 2, state: { roundRobin: 0, reservations: {}, ledgers: {}, circuits: {}, unavailableProfiles: {} } };
const emptyClaudeState = { version: 1, state: { reservations: {}, ledgers: {}, circuits: {} } };

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "sigil-profile-cli-"));
  writePrivate(home, "codex-profiles/registry.json", { version: 1, profiles: [
    { name: "shared", home: "/seeded/private/codex", enabled: true, profileClass: "subscription", percentageQuantum: 10, reserveFloorPercentage: 20 },
    { name: "codex-only", home: "/seeded/private/other", enabled: true, profileClass: "metered-api", meteredMode: "manual", budget: { startLimit: 2, reservationTokens: 100 } },
  ] });
  writePrivate(home, "codex-profiles/routing-state.json", emptyCodexState);
  writePrivate(home, "claude-profiles/registry.json", { version: 1, profiles: [
    { provider: "claude", name: "shared", enabled: true, accessClass: "subscription", details: { configurationDirectory: "/seeded/private/claude" } },
    { provider: "claude", name: "api", enabled: true, accessClass: "metered-api", mode: "manual", admission: { startLimit: 1 }, operation: { usdLimit: 1 }, details: { credentialSource: "SECRET_ENV" } },
  ] });
  writePrivate(home, "claude-profiles/routing-state.json", emptyClaudeState);
  return home;
}

function writePrivate(home: string, relative: string, value: unknown) {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  chmodSync(path, 0o600);
}

function run(home: string, args: string[]) {
  return Bun.spawnSync({ cmd: ["bun", "src/cli.ts", "profile", ...args], cwd: process.cwd(), env: { ...process.env, SIGIL_HOME: home }, stdout: "pipe", stderr: "pipe" });
}

function text(bytes: Uint8Array) { return new TextDecoder().decode(bytes); }

describe("profile CLI", () => {
  test("list, inspect, and status are distinct versioned safe records", () => {
    const home = fixture();
    const list = run(home, ["list", "--json"]);
    const inspect = run(home, ["inspect", "codex:shared", "--json"]);
    const status = run(home, ["status", "--provider", "claude", "--json"]);

    expect(JSON.parse(text(list.stdout))).toMatchObject({ version: 1, kind: "profile-list" });
    expect(JSON.parse(text(inspect.stdout))).toMatchObject({ version: 1, kind: "profile-inspection" });
    expect(JSON.parse(text(status.stdout))).toMatchObject({ version: 1, kind: "profile-status" });
    for (const result of [list, inspect, status]) {
      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).not.toContain("/seeded/private");
      expect(text(result.stdout)).not.toContain("SECRET_ENV");
      expect(text(result.stderr)).toBe("");
    }

    const claudeStatus = JSON.parse(text(status.stdout));
    expect(claudeStatus.profiles[0].evidence).toEqual({
      authentication: { kind: "unknown" },
      capacity: { kind: "unknown" },
    });
    expect(claudeStatus.profiles[0].eligibility).toBe("eligible");
    expect(text(status.stdout)).not.toContain("percentage");
  });

  test("qualified and unique bare selectors work while ambiguous selectors do not mutate", () => {
    const home = fixture();
    const registry = join(home, "codex-profiles/registry.json");
    const before = readFileSync(registry);
    const qualified = run(home, ["disable", "codex:shared", "--json"]);
    const unique = run(home, ["enable", "codex-only"]);
    const afterValid = readFileSync(registry);
    const ambiguous = run(home, ["disable", "shared"]);

    expect(qualified.exitCode).toBe(0);
    expect(unique.exitCode).toBe(0);
    expect(afterValid.equals(before)).toBe(false);
    expect(ambiguous.exitCode).toBe(2);
    expect(readFileSync(registry).equals(afterValid)).toBe(true);
  });

  test("next is bounded and respects disabled state, circuits, and budgets", () => {
    const home = fixture();
    const next = run(home, ["next", "codex:codex-only", "--agents", "2", "--json"]);
    expect(next.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "codex-profiles/routing-state.json"), "utf8")).state.next).toEqual({ profile: "codex-only", remaining: 2 });

    expect(run(home, ["disable", "codex:codex-only"]).exitCode).toBe(0);
    const before = readFileSync(join(home, "codex-profiles/routing-state.json"));
    expect(run(home, ["next", "codex:codex-only", "--agents", "1"]).exitCode).toBe(2);
    expect(readFileSync(join(home, "codex-profiles/routing-state.json")).equals(before)).toBe(true);
  });

  test("next persists a bounded Claude one-shot selection", () => {
    const home = fixture();

    const next = run(home, ["next", "claude:api", "--agents", "2", "--json"]);

    expect(next.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "claude-profiles/routing-state.json"), "utf8")).state.next).toEqual({ profile: "api", remaining: 2 });
  });

  test("adds a Claude subscription profile using the provider default configuration", () => {
    const home = fixture();

    const result = run(home, [
      "add",
      "default",
      "--provider",
      "claude",
      "--class",
      "subscription",
      "--default-config",
      "--json",
    ]);
    const registry = JSON.parse(
      readFileSync(join(home, "claude-profiles/registry.json"), "utf8"),
    );

    expect(result.exitCode).toBe(0);
    expect(registry.profiles.at(-1).details).toEqual({ defaultConfiguration: true });
  });

  test("rearm clears the selected circuit and Claude prime is typed unsupported", () => {
    const home = fixture();
    writePrivate(home, "claude-profiles/routing-state.json", { version: 1, state: { ...emptyClaudeState.state, circuits: { shared: { reason: "capacity", openedAt: new Date().toISOString() } } } });
    expect(run(home, ["rearm", "claude:shared", "--json"]).exitCode).toBe(0);
    const prime = run(home, ["prime", "claude:shared", "--json"]);
    expect(JSON.parse(text(prime.stdout))).toMatchObject({ kind: "profile-operation", operation: "prime", support: "unsupported" });
  });

  test("Codex rearm changes only circuit and rearm-required state", () => {
    const home = fixture();
    const state = {
      ...emptyCodexState.state,
      reservations: { active: { id: "active", profile: "codex-only", owner: { pid: process.pid, startIdentity: "live" }, startedAt: new Date().toISOString(), reservedTokens: 100, unresolved: true } },
      ledgers: { "codex-only": { starts: 2, active: 1, reservedTokens: 100, runtimeMs: 12, usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 5 }, rearmRequired: true } },
      circuits: { "codex-only": { reason: "capacity", openedAt: new Date().toISOString() } },
    };
    writePrivate(home, "codex-profiles/routing-state.json", { version: 2, state });

    expect(run(home, ["rearm", "codex:codex-only", "--json"]).exitCode).toBe(0);
    const updated = JSON.parse(readFileSync(join(home, "codex-profiles/routing-state.json"), "utf8")).state;

    expect(updated.reservations).toEqual(state.reservations);
    expect(updated.ledgers["codex-only"]).toEqual({ ...state.ledgers["codex-only"], rearmRequired: false });
    expect(updated.circuits["codex-only"]).toBeUndefined();
  });

  test("out-of-range Codex reserve floor leaves the registry unchanged", () => {
    const home = fixture();
    const registry = join(home, "codex-profiles/registry.json");
    const before = readFileSync(registry);

    const result = run(home, ["add", "bad-floor", "--provider", "codex", "--home", home, "--reserve-floor", "101"]);

    expect(result.exitCode).toBe(2);
    expect(readFileSync(registry).equals(before)).toBe(true);
  });

  test("invalid unbounded Claude metered add leaves the registry byte-for-byte unchanged", () => {
    const home = fixture();
    const registry = join(home, "claude-profiles/registry.json");
    const before = readFileSync(registry);
    const result = run(home, ["add", "bad", "--provider", "claude", "--class", "metered-api", "--credential-source", "SECRET_ENV", "--mode", "manual"]);
    expect(result.exitCode).toBe(2);
    expect(readFileSync(registry).equals(before)).toBe(true);
  });
});
