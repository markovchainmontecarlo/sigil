import { describe, expect, test } from "bun:test";

import { recover, retryOperation, type WorkflowFailure } from "../src/recovery/index.js";

const failure = (evidence: string): WorkflowFailure => ({
  kind: "gate",
  stage: "implementation",
  evidence,
  paths: ["outside.ts"],
  attempts: 0,
  recoverable: true,
});

describe("recovery policy", () => {
  test("repairs a recoverable failure and returns attempt history", async () => {
    let repaired = false;
    const result = await recover({
      limit: 2,
      attempt: async () => repaired
        ? { ok: true as const, value: "green" }
        : { ok: false as const, failure: failure("outside scope") },
      repair: async () => { repaired = true; },
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.failures).toHaveLength(1);
  });

  test("returns a structured terminal failure after the repair budget", async () => {
    const result = await recover({
      limit: 1,
      attempt: async () => ({ ok: false, failure: failure("still outside scope") }),
      repair: async () => {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.attempts).toBe(2);
  });

  test("retries thrown operations and preserves failure history", async () => {
    let attempts = 0;

    const result = await retryOperation({
      limit: 2,
      run: async () => {
        attempts++;
        if (attempts === 1) throw new Error("invalid structured output");
        return "valid";
      },
      failure: (error, attempt, recoverable) => ({
        kind: "provider",
        stage: "plan-synthesis",
        evidence: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        recoverable,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.evidence).toContain("invalid structured output");
  });

  test("turns an operation timeout into local retry evidence", async () => {
    let calls = 0;
    const result = await retryOperation({
      limit: 1,
      timeoutMs: 5,
      operation: "slow-review",
      run: async () => {
        calls++;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return "complete";
      },
      failure: (error, attempt, recoverable) => ({
        kind: "provider",
        stage: "slow-review",
        evidence: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        recoverable,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.failures[0]?.evidence).toContain("timed out");
    expect(calls).toBe(2);
  });
});
