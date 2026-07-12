import { describe, expect, test } from "bun:test";

import {
  classifyProviderFailure,
  ProviderError,
  type ProviderFailureCode,
  type ProviderRetryDisposition,
} from "../src/provider-failure.js";
import { recoveryIdentity } from "../src/workflows/dispatch/recovery.js";
import type { WorkflowFailure } from "../src/recovery/index.js";

const cases: Array<{
  message: string;
  code: ProviderFailureCode;
  disposition: ProviderRetryDisposition;
}> = [
  { message: "usage limit reached for this account", code: "capacity_exhausted", disposition: "reroute" },
  { message: "authentication failed: expired token", code: "authentication_failed", disposition: "terminal" },
  { message: "operation timed out after 30000ms", code: "operation_timeout", disposition: "retry" },
  { message: "idle timeout while waiting for the agent", code: "idle_timeout", disposition: "retry" },
  { message: "service temporarily unavailable; try again", code: "transient", disposition: "retry" },
  { message: "invalid request: malformed model input", code: "invalid_request", disposition: "terminal" },
  { message: "request was cancelled", code: "cancelled", disposition: "terminal" },
  { message: "schema conversion failed", code: "unknown", disposition: "retry" },
];

describe("provider failure classification", () => {
  test.each(cases)("classifies $code", ({ message, code, disposition }) => {
    const cause = new Error("root cause");
    const failure = classifyProviderFailure(new Error(message, { cause }));

    expect(failure.code).toBe(code);
    expect(failure.disposition).toBe(disposition);
    expect(failure.evidence.message).toBe(message);
    expect(failure.evidence.cause).toMatchObject({ message: "root cause" });
  });

  test("preserves ACP stderr as structured evidence", () => {
    const failure = classifyProviderFailure(new Error(
      "ACP prompt failed\n\nACP agent stderr:\nError: rate limit reached for account 42",
    ));

    expect(failure.code).toBe("capacity_exhausted");
    expect(failure.evidence.message).toBe("ACP prompt failed");
    expect(failure.evidence.stderr).toContain("rate limit reached");
  });

  test("uses structured RPC evidence ahead of mutable prose", () => {
    const first = classifyProviderFailure(new ProviderError("bad parameters", {
      code: "invalid_request",
      operation: "account/read",
      rpcCode: -32602,
    }));
    const reworded = classifyProviderFailure(new ProviderError("request arguments were rejected", {
      code: "invalid_request",
      operation: "account/read",
      rpcCode: -32602,
    }));
    const different = classifyProviderFailure(new ProviderError("bad parameters", {
      code: "invalid_request",
      operation: "account/rateLimits/read",
      rpcCode: -32602,
    }));

    expect(first.fingerprint).toBe(reworded.fingerprint);
    expect(first.fingerprint).not.toBe(different.fingerprint);
  });

  test("dispatch accounting prefers provider fingerprints and retains issue fallback", () => {
    const provider = classifyProviderFailure(new Error("service temporarily unavailable"));
    const failure: WorkflowFailure = {
      kind: "provider",
      stage: "implementation",
      evidence: "wording one",
      attempts: 1,
      recoverable: true,
      provider,
    };

    expect(recoveryIdentity("wording one", [failure])).toBe(provider.fingerprint);
    expect(recoveryIdentity("gate failed\n details")).toBe("issue:gate failed details");
  });
});
