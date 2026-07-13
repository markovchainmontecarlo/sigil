import { describe, expect, test } from "bun:test";

import { inspectEnvironment, type PrerequisiteReaders } from "../src/commands/environment.js";
import { DEFAULT_SIGIL_CONFIG, type SigilConfig } from "../src/config.js";

const readers: PrerequisiteReaders = {
  codexAdapter: () => true,
  claudeCli: () => false,
  claudeSdk: () => true,
  copilotCli: () => false,
  copilotSdk: () => true,
  directory: (path) => path.endsWith("available"),
  credentialSource: (name) => name === "AVAILABLE_SECRET",
};

describe("environment inspection", () => {
  test("reports safe prerequisites per role and candidate transport", async () => {
    const config: SigilConfig = {
      ...DEFAULT_SIGIL_CONFIG,
      agents: {
        codexRole: { provider: "codex", model: "private-model", effort: "medium" },
        claudeRole: { provider: "claude", model: "private-claude", effort: "medium" },
      },
    };
    const report = await inspectEnvironment(config, readers, {
      codex: [{ name: "private-profile", home: "/secret/available", enabled: true, profileClass: "subscription" }],
      claude: [
        { provider: "claude", name: "subscription", enabled: true, accessClass: "subscription", details: { configurationDirectory: "/secret/missing" } },
        { provider: "claude", name: "api", enabled: true, accessClass: "metered-api", mode: "manual", admission: { startLimit: 1 }, operation: { usdLimit: 1 }, details: { credentialSource: "AVAILABLE_SECRET" } },
      ],
    });
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({ version: 1, kind: "environment-prerequisites" });
    expect(report.roles.find((role) => role.role === "claudeRole")?.candidates).toEqual([
      { transport: "claude-cli-pty", accessClass: "subscription", prerequisites: [{ kind: "executable", available: false }, { kind: "configuration-directory", available: false }] },
      { transport: "claude-agent-sdk", accessClass: "metered-api", prerequisites: [{ kind: "adapter-package", available: true }, { kind: "credential-source", available: true }] },
    ]);
    for (const secret of ["private-model", "private-claude", "private-profile", "/secret", "AVAILABLE_SECRET"]) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("authentication");
    expect(serialized).not.toContain("capacity");
  });
});
