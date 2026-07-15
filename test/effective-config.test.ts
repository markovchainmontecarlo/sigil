import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig, resolveConfig } from "../src/config.js";
import { EFFECTIVE_CONFIG_VERSION, projectEffectiveConfig } from "../src/effective-config.js";

const project = {
  agents: { worker: { provider: "codex", model: "project-model", effort: "medium" } },
  evals: {},
  plan: { planners: ["worker"], synthesizer: "worker", reviewer: "worker" },
  implement: { coder: "worker", sessionTaskLimit: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
  review: { reviewers: ["worker"], synthesizer: "worker", followUpReviews: 0 },
};

function repoWithConfig(value: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "sigil-effective-config-"));
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify(value));
  return repo;
}

describe("effective configuration", () => {
  test("attributes command, project, and default leaves by precedence", () => {
    const repo = repoWithConfig(project);
    const resolved = resolveConfig(repo, {
      agents: { worker: { model: "command-model" } },
    });
    const effective = projectEffectiveConfig(resolved);

    expect(effective.version).toBe(EFFECTIVE_CONFIG_VERSION);
    expect(effective.values["agents.worker.model"]).toMatchObject({ value: "command-model", source: "command" });
    expect(effective.values["implement.sessionTaskLimit"]).toMatchObject({ value: 5, source: "project" });
    expect(effective.values["implement.idleTimeoutMs"]).toMatchObject({ source: "default" });
    expect(effective.values["plan.reviewer"]).toMatchObject({ value: "worker", source: "project" });
  });

  test("preserves explicit values equal to defaults and reports a safe location", () => {
    const repo = repoWithConfig(project);
    const effective = projectEffectiveConfig(resolveConfig(repo));
    const value = effective.values["review.followUpReviews"];

    expect(value).toMatchObject({ value: 0, source: "project", location: { file: "sigil.config.json" } });
    expect(JSON.stringify(value)).not.toContain(repo);
  });

  test("reports candidates without eligibility or an assignment", () => {
    const sentinel = "SECRET_PROFILE_HOME_SENTINEL";
    const repo = repoWithConfig(project);
    process.env.SIGIL_PROFILE_HOME = sentinel;
    const effective = projectEffectiveConfig(resolveConfig(repo));
    const serialized = JSON.stringify(effective);
    delete process.env.SIGIL_PROFILE_HOME;

    expect(effective.routing.candidateProfiles).toEqual([]);
    expect(effective.routing.assignment).toBe("resolved-at-agent-creation");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("eligibility");
  });

  test("loadConfig remains the value-only projection and validates references", () => {
    const repo = repoWithConfig(project);
    expect(loadConfig(repo)).toEqual(resolveConfig(repo).config);

    const invalid = repoWithConfig({ ...project, plan: { planners: ["missing"], synthesizer: "worker", reviewer: "worker" } });
    expect(() => loadConfig(invalid)).toThrow("missing");
  });
});
