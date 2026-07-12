import { describe, expect, test } from "bun:test";

import { recover, retryOperation, type WorkflowFailure } from "../src/recovery/index.js";
import { classifyProviderFailure } from "../src/provider-failure.js";

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
      cancellationGraceMs: 30,
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

  test("returns after the cancellation grace when abort is ignored", async () => {
    const started = performance.now();
    let calls = 0;

    const result = await retryOperation({
      limit: 1,
      timeoutMs: 5,
      cancellationGraceMs: 5,
      operation: "stuck-provider",
      run: async () => {
        calls++;
        return await new Promise<string>(() => {});
      },
      failure: (error, attempt, recoverable) => ({
        kind: "provider",
        stage: "stuck-provider",
        evidence: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        recoverable,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.evidence).toContain("timed out");
    expect(result.failures[0]?.recoverable).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(calls).toBe(1);
  });

  test("observes a provider rejection after the cancellation grace", async () => {
    let rejectProvider: (error: Error) => void = () => {};
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await retryOperation({
        limit: 0,
        timeoutMs: 5,
        cancellationGraceMs: 5,
        run: async () => await new Promise<string>((_, reject) => {
          rejectProvider = reject;
        }),
        failure: (error, attempt, recoverable) => ({
          kind: "provider",
          stage: "late-rejection",
          evidence: error instanceof Error ? error.message : String(error),
          attempts: attempt,
          recoverable,
        }),
      });

      expect(result.ok).toBe(false);
      rejectProvider(new Error("late provider rejection"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("settles cancellation before starting the next attempt", async () => {
    let active = 0;
    let maximumActive = 0;
    const events: string[] = [];

    const result = await retryOperation({
      limit: 1,
      timeoutMs: 5,
      cancellationGraceMs: 30,
      run: async (attempt, controls) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        events.push(`start-${attempt}`);
        if (attempt === 1) {
          await new Promise<void>((resolve) => controls.signal.addEventListener("abort", () => {
            setTimeout(() => {
              active--;
              events.push("settled-1");
              resolve();
            }, 5);
          }, { once: true }));
          return "late";
        }
        active--;
        return "complete";
      },
      failure: (error, attempt, recoverable) => ({
        kind: "provider",
        stage: "ordered-cleanup",
        evidence: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        recoverable,
      }),
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(["start-1", "settled-1", "start-2"]);
    expect(maximumActive).toBe(1);
  });

  test.each([
    "authentication failed: expired token",
    "invalid request: malformed input",
  ])("terminal provider failure stops after one attempt: %s", async (message) => {
    let calls = 0;
    const result = await retryOperation({
      limit: 4,
      run: async () => {
        calls++;
        throw new Error(message);
      },
      failure: (error, attempt, retryAvailable) => {
        const provider = classifyProviderFailure(error);
        return {
          kind: "provider",
          stage: "agent",
          evidence: message,
          attempts: attempt,
          recoverable: retryAvailable && provider.disposition !== "terminal",
          provider,
        };
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("transient provider failure remains eligible for the retry budget", async () => {
    let calls = 0;
    const result = await retryOperation({
      limit: 2,
      run: async () => {
        calls++;
        if (calls < 3) throw new Error("service temporarily unavailable");
        return "complete";
      },
      failure: (error, attempt, retryAvailable) => {
        const provider = classifyProviderFailure(error);
        return {
          kind: "provider",
          stage: "agent",
          evidence: provider.evidence.message,
          attempts: attempt,
          recoverable: retryAvailable && provider.disposition === "retry",
          provider,
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});
