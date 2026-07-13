import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { claudeProfileStore, readClaudeProfiles, resolveClaudeCredentialSource, safeClaudeProfile, writeClaudeProfiles, type ClaudeProfile } from "../src/claude-profiles.js";
import { codexProfileStore, readCodexProfiles } from "../src/codex-profiles.js";
import { resolveProfileSelector } from "../src/provider-profiles.js";

const root = () => mkdtempSync(join(tmpdir(), "sigil-provider-profiles-"));
const subscription = (name: string): ClaudeProfile => ({ provider: "claude", name, enabled: true, accessClass: "subscription", details: { configurationDirectory: `/private/${name}` } });

describe("provider profile contracts", () => {
  test("qualified selectors are exact and bare selectors require global uniqueness", () => {
    const profiles = [{ provider: "codex" as const, name: "pro" }, { provider: "claude" as const, name: "pro" }, { provider: "claude" as const, name: "unique" }];
    expect(resolveProfileSelector("codex:pro", profiles).provider).toBe("codex");
    expect(() => resolveProfileSelector("pro", profiles)).toThrow("ambiguous");
    expect(resolveProfileSelector("unique", profiles).provider).toBe("claude");
  });

  test("Claude records persist privately and project to redacted DTOs", async () => {
    const store = claudeProfileStore(root());
    const profile = subscription("pro");
    await writeClaudeProfiles([profile], store);
    expect(await readClaudeProfiles(store)).toEqual([profile]);
    expect(safeClaudeProfile(profile).qualifiedIdentity).toBe("claude:pro");
    expect(JSON.stringify(safeClaudeProfile(profile))).not.toContain("/private");
  });

  test("metered Claude profiles require bounded admission and operation limits", async () => {
    const store = claudeProfileStore(root());
    const invalid = { provider: "claude", name: "api", enabled: true, accessClass: "metered-api", details: { credentialSource: "CLAUDE_KEY" } } as ClaudeProfile;
    await expect(writeClaudeProfiles([invalid], store)).rejects.toThrow();
  });

  test("credential sources resolve without entering safe DTOs", () => {
    const profile: ClaudeProfile = { provider: "claude", name: "api", enabled: true, accessClass: "metered-api", mode: "manual", admission: { startLimit: 1 }, operation: { usdLimit: 1 }, details: { credentialSource: "CLAUDE_KEY" } };
    expect(resolveClaudeCredentialSource(profile, { CLAUDE_KEY: "secret" })).toBe("secret");
    expect(JSON.stringify(safeClaudeProfile(profile))).not.toContain("CLAUDE_KEY");
    expect(() => resolveClaudeCredentialSource(profile, {})).toThrow("unresolved");
  });

  test("corrupt, unsupported, and unsafe registries fail closed", async () => {
    const store = codexProfileStore(root());
    mkdirSync(dirname(store.registryFile), { recursive: true });
    await Bun.write(store.registryFile, "not-json");
    chmodSync(store.registryFile, 0o600);
    await expect(readCodexProfiles(store)).rejects.toMatchObject({ code: "corrupt" });
    await Bun.write(store.registryFile, JSON.stringify({ version: 99, profiles: [] }));
    chmodSync(store.registryFile, 0o600);
    await expect(readCodexProfiles(store)).rejects.toMatchObject({ code: "unsupported-version" });
    chmodSync(store.registryFile, 0o644);
    await expect(readCodexProfiles(store)).rejects.toMatchObject({ code: "unsafe-permissions" });
  });
});
