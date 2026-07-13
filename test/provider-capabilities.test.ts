import { describe, expect, test } from "bun:test";

import { providerCapabilities, resolveExecutionPolicy } from "../src/provider-capabilities.js";

describe("provider capabilities", () => {
  test("reports every adapter independently without adding Copilot profiles", () => {
    expect(providerCapabilities("codex-acp")).toMatchObject({ provider: "codex", priming: "supported" });
    expect(providerCapabilities("claude-cli-pty")).toMatchObject({ provider: "claude", sandbox: "unsupported" });
    expect(providerCapabilities("claude-agent-sdk")).toMatchObject({ provider: "claude", sandbox: "unsupported" });
    expect(providerCapabilities("copilot-cli")).toMatchObject({ provider: "copilot", priming: "unsupported" });
    expect(providerCapabilities("copilot-sdk")).toMatchObject({ provider: "copilot", priming: "unsupported" });
  });

  test("keeps requested and effective execution distinct", () => {
    const codex = resolveExecutionPolicy("codex-acp");
    const claude = resolveExecutionPolicy("claude-cli-pty");

    expect(codex.requested.sandbox).toBe("unrestricted");
    expect(codex.effective.sandbox).toBe("workspace-write");
    expect(claude.effective.sandbox).toBe("unrestricted");
    expect(claude.adapter.args).toContain("--dangerously-skip-permissions");
  });

  test("rejects execution guarantees an adapter cannot enforce", () => {
    expect(() => resolveExecutionPolicy("claude-agent-sdk", { sandbox: "workspace-write" })).toThrow();
    expect(() => resolveExecutionPolicy("copilot-sdk", { network: "disabled" })).toThrow();
  });
});
