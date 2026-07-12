import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

describe("codex-profile CLI", () => {
  test("status redacts profile homes", () => {
    const home = mkdtempSync(join(tmpdir(), "sigil-profile-cli-"));
    const profileDir = join(home, "codex-profiles");
    const secretHome = "/private/account/home";
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "registry.json"), JSON.stringify({
      version: 1,
      profiles: [{
        name: "primary",
        home: secretHome,
        enabled: true,
        profileClass: "subscription",
      }],
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
  });
});
