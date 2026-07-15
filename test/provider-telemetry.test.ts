import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createContext } from "../src/context.js";
import { ObservationEnvelopeSchema, terminalObservationSummary } from "../src/provider-telemetry.js";
import { classifyProviderFailure, publicProviderFailure, ProviderError } from "../src/provider-failure.js";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "sigil-telemetry-"));
  writeFileSync(join(path, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "model" } }, evals: {}, context: [],
    plan: { planners: ["coder"], synthesizer: "coder", reviewer: "coder" },
    implement: { coder: "coder", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "x/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  }));
  return path;
}

describe("provider telemetry", () => {
  test("persists versioned nested JSON-safe details and renders scalars only", async () => {
    const ctx = createContext(repo());
    await ctx.observe("provider-usage-updated", { usage: { inputTokens: 3 }, outcome: "observed" });
    const event = ObservationEnvelopeSchema.parse(JSON.parse(readFileSync(ctx.artifacts.path("events.jsonl"), "utf8")));
    expect(event.details.usage).toEqual({ inputTokens: 3 });
    expect(terminalObservationSummary(event.details)).toBe("observed");
  });

  test("public failures omit messages, stderr, accounts, and causes", () => {
    const failure = classifyProviderFailure(new ProviderError("secret prompt", {
      code: "authentication_failed", stderr: "raw stderr", account: "account@example.test",
    }));
    const projected = JSON.stringify(publicProviderFailure(failure));
    expect(projected).not.toContain("secret");
    expect(projected).not.toContain("stderr");
    expect(projected).not.toContain("example.test");
  });
});
