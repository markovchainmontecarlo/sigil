import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { promptAgentTurn, runFreshAgentOperation } from "../src/agent-operation.js";
import type { AgentPromptOptions, SigilAgent } from "../src/agents.js";
import { createContext } from "../src/context.js";
import type { RichSigilAgent } from "../src/context.js";

function repo(): string {
  const directory = mkdtempSync(join(tmpdir(), "sigil-agent-attempt-"));
  writeFileSync(join(directory, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "test" } },
    evals: {},
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "x/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  }));
  return directory;
}

describe("agent attempts", () => {
  test("records prompt size, attempt duration, and operation duration", async () => {
    const observations: Array<{ stage: string; details: Record<string, string> }> = [];
    const ctx = createContext(repo(), {
      onObserve: async (stage, details) => { observations.push({ stage, details }); },
    });
    const agent: SigilAgent = {
      prompt: async () => "complete",
      async close() {},
      async [Symbol.asyncDispose]() {},
    };

    await promptAgentTurn(ctx, agent as RichSigilAgent, "work", {
      stage: "measured-turn",
      limit: 1,
      timeoutMs: 100,
      idleTimeoutMs: 50,
    });

    expect(observations).toContainEqual(expect.objectContaining({
      stage: "agent-turn-prepared",
      details: expect.objectContaining({ stage: "measured-turn", promptCharacters: "4" }),
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "agent-attempt-completed",
      details: expect.objectContaining({ stage: "measured-turn", durationMs: expect.any(String) }),
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      stage: "agent-operation-completed",
      details: expect.objectContaining({ stage: "measured-turn", durationMs: expect.any(String) }),
    }));
  });

  test("retries a transient persistent-agent turn within its configured budget", async () => {
    let calls = 0;
    const ctx = createContext(repo());
    const agent: SigilAgent = {
      prompt: async () => {
        if (++calls === 1) throw new Error("service temporarily unavailable; try again");
        return "complete";
      },
      async close() {},
      async [Symbol.asyncDispose]() {},
    };

    const result = await promptAgentTurn(ctx, agent as RichSigilAgent, "work", {
      stage: "persistent",
      limit: 1,
      timeoutMs: 100,
      idleTimeoutMs: 50,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("returns persistent-agent capacity failure without replaying the turn", async () => {
    let calls = 0;
    const ctx = createContext(repo());
    const agent: SigilAgent = {
      runtime: { provider: "codex", profile: "full" },
      prompt: async () => {
        calls++;
        throw new Error("usage limit reached for this account");
      },
      async close() {},
      async [Symbol.asyncDispose]() {},
    };

    const result = await promptAgentTurn(ctx, agent as RichSigilAgent, "work", {
      stage: "persistent-capacity",
      limit: 3,
      timeoutMs: 100,
      idleTimeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    if (!result.ok) expect(result.failure.provider?.disposition).toBe("reroute");
  });

  test("closes a timed-out attempt before creating its retry", async () => {
    const events: string[] = [];
    let identity = 0;
    let active = 0;
    const ctx = createContext(repo(), {
      createAgent: () => {
        const id = ++identity;
        active++;
        expect(active).toBe(1);
        const agent: SigilAgent = {
          prompt: async () => "unused",
          promptWithOptions: (_text, _schema, options) => new Promise((_, reject) => {
            const transport = setInterval(() => {}, 1_000);
            options.signal?.addEventListener("abort", () => {
              clearInterval(transport);
              events.push(`abort:${id}`);
              reject(options.signal?.reason);
            }, { once: true });
          }),
          async close() { active--; events.push(`close:${id}`); },
          async [Symbol.asyncDispose]() { await this.close(); },
        };
        return agent;
      },
    });

    const result = await runFreshAgentOperation(ctx, "coder", {
      stage: "attempt",
      limit: 1,
      timeoutMs: 100,
      idleTimeoutMs: 500,
    }, (agent) => agent.prompt("work"));

    expect(result.ok).toBe(false);
    expect(identity).toBe(2);
    expect(active).toBe(0);
    expect(events).toEqual(["abort:1", "close:1", "abort:2", "close:2"]);
  });

  test("meaningful progress postpones idle timeout but heartbeat-like silence does not", async () => {
    let calls = 0;
    const ctx = createContext(repo(), {
      createAgent: () => ({
        prompt: async () => "unused",
        promptWithOptions: async (_text, _schema, options: AgentPromptOptions) => {
          calls++;
          if (calls === 1) {
            await abortResult(options);
            return "never";
          }
          const timer = setInterval(() => options.onProgress?.("provider"), 8);
          await new Promise((resolve) => setTimeout(resolve, 35));
          clearInterval(timer);
          return "complete";
        },
        async close() {},
        async [Symbol.asyncDispose]() {},
      }),
    });

    const result = await runFreshAgentOperation(ctx, "coder", {
      stage: "idle",
      limit: 1,
      timeoutMs: 500,
      idleTimeoutMs: 100,
    }, (agent) => agent.prompt("work"));

    expect(result.ok).toBe(true);
    expect(result.failures[0]?.provider?.code).toBe("idle_timeout");
  });

  test.each([
    "authentication failed: expired token",
    "invalid request: malformed input",
  ])("terminal failure does not create a second connection: %s", async (message) => {
    let connections = 0;
    const ctx = createContext(repo(), {
      createAgent: () => {
        connections++;
        return {
          prompt: async () => { throw new Error(message); },
          async close() {},
          async [Symbol.asyncDispose]() {},
        };
      },
    });

    const result = await runFreshAgentOperation(ctx, "coder", {
      stage: "terminal",
      limit: 3,
      timeoutMs: 100,
      idleTimeoutMs: 50,
    }, (agent) => agent.prompt("work"));

    expect(result.ok).toBe(false);
    expect(connections).toBe(1);
  });
});

function abortResult(options: AgentPromptOptions): Promise<never> {
  return new Promise((_, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
      once: true,
    });
  });
}
