import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "sigil-config-test-"));
}

function writeConfig(root: string, config: unknown): void {
  writeFileSync(join(root, "sigil.config.json"), JSON.stringify(config, null, 2));
}

const validConfig = {
  agents: {
    explorer: { provider: "codex", model: "gpt-5.5", effort: "medium" },
    implementer: { provider: "codex", model: "gpt-5.5", effort: "medium" },
    reviewer: { provider: "codex", model: "gpt-5.5" },
  },
  evals: { build: "bun run typecheck", test: "bun test" },
  plan: { planners: ["explorer", "implementer"], synthesizer: "explorer" },
  implement: { coder: "implementer", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
  review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
};

describe("loadConfig", () => {
  test("valid fixture config parses", () => {
    const root = tempRepo();
    const child = join(root, "nested");
    mkdirSync(child);
    writeConfig(root, validConfig);

    const config = loadConfig(child);

    expect(config.agents.implementer).toEqual({ provider: "codex", model: "gpt-5.5", effort: "medium" });
    expect(config.agents.reviewer).toEqual({ provider: "codex", model: "gpt-5.5", effort: "medium" });
    expect(config.evals.build).toBe("bun run typecheck");
    expect(config.context).toEqual([]);
    expect(config.plan.planners).toEqual(["explorer", "implementer"]);
    expect(config.review.followUpReviews).toBe(0);
    expect(config.implement.idleTimeoutMs).toBePositive();
  });

  test.each(["operationTimeoutMs", "idleTimeoutMs"])("%s must be positive", (field) => {
    const root = tempRepo();
    writeConfig(root, {
      ...validConfig,
      implement: { ...validConfig.implement, [field]: 0 },
    });

    expect(() => loadConfig(root)).toThrow();
  });

  test("context entries parse with update defaulting false", () => {
    const root = tempRepo();
    writeConfig(root, {
      ...validConfig,
      context: [
        { path: "ARCHITECTURE.md" },
        { path: "remaining-work.md", update: true },
      ],
    });

    expect(loadConfig(root).context).toEqual([
      { path: "ARCHITECTURE.md", update: false },
      { path: "remaining-work.md", update: true },
    ]);
  });

  test("workspace readiness is optional and rejects empty commands", () => {
    const root = tempRepo();
    writeConfig(root, {
      ...validConfig,
      workspace: { bootstrap: "install", ready: "test -d dependencies" },
    });
    expect(loadConfig(root).workspace).toEqual({
      bootstrap: "install",
      ready: "test -d dependencies",
    });

    const invalid = tempRepo();
    writeConfig(invalid, { ...validConfig, workspace: { bootstrap: "install", ready: "" } });
    expect(() => loadConfig(invalid)).toThrow();
    expect(loadConfig(root).workspace.bootstrap).toBe("install");
  });

  test("copilot agent provider parses", () => {
    const root = tempRepo();
    writeConfig(root, {
      ...validConfig,
      agents: {
        ...validConfig.agents,
        reviewer: { provider: "copilot", model: "gpt-5", effort: "medium" },
      },
    });

    expect(loadConfig(root).agents.reviewer).toEqual({ provider: "copilot", model: "gpt-5", effort: "medium" });
  });

  test("context entries must be objects with non-empty paths", () => {
    const root = tempRepo();
    writeConfig(root, { ...validConfig, context: ["ARCHITECTURE.md"] });
    expect(() => loadConfig(root)).toThrow();

    const second = tempRepo();
    writeConfig(second, { ...validConfig, context: [{ path: "" }] });
    expect(() => loadConfig(second)).toThrow();
  });

  test("absent file throws naming the path", () => {
    const root = tempRepo();

    expect(() => loadConfig(root)).toThrow(join(root, "sigil.config.json"));
  });

  test("unknown plan planner throws naming the entry", () => {
    const root = tempRepo();
    writeConfig(root, { ...validConfig, plan: { ...validConfig.plan, planners: ["missing-planner"] } });

    expect(() => loadConfig(root)).toThrow("missing-planner");
  });
});
