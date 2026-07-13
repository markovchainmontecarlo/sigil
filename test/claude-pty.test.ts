import { describe, expect, test } from "bun:test";

import { createClaudePtyAgent, type ClaudePtyDependencies } from "../src/claude-pty.js";
import { classifyProviderFailure } from "../src/provider-failure.js";

const subscription = { provider: "claude" as const, name: "test", enabled: true, accessClass: "subscription" as const, details: { configurationDirectory: "/home/test/.claude" } };

const binding = { provider: "claude" as const, model: "claude-test", effort: "medium" as const };

function constructionDependencies(
  env: NodeJS.ProcessEnv,
  executable: (path: string) => void,
): Partial<ClaudePtyDependencies> {
  return {
    env,
    home: "/home/test",
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    executable,
  };
}

describe("Claude PTY transport", () => {
  test("uses Claude's default configuration without overriding CLAUDE_CONFIG_DIR", async () => {
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    let promptWritten = false;
    const profile = {
      ...subscription,
      details: { defaultConfiguration: true as const },
    };
    const agent = createClaudePtyAgent(binding, "/repo", profile, {}, {
      ...constructionDependencies({
        HOME: "/home/test",
        USER: "test-user",
        CLAUDE_CONFIG_DIR: "/inherited/config",
        SIGIL_CLAUDE_PTY_BIN: "/claude",
      }, () => {}),
      promptSubmitDelayMs: 0,
      readTranscript: async () => promptWritten
        ? transcript("question", "answer")
        : "",
      spawn: async (options) => {
        childEnvironment = options.env;
        options.onData?.(new TextEncoder().encode("Claude Code ? for shortcuts"));
        return {
          write: () => { promptWritten = true; return 1; },
          close: async () => {},
          wait: async () => await new Promise<number>(() => {}),
        };
      },
    });

    await expect(agent.prompt("question")).resolves.toBe("answer");
    expect(childEnvironment?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(childEnvironment?.USER).toBe("test-user");
  });

  test("selects the Sigil override before the generic override and PATH", () => {
    const checked: string[] = [];
    const agent = createClaudePtyAgent(binding, "/repo", subscription, {}, constructionDependencies({
      SIGIL_CLAUDE_PTY_BIN: "/sigil/claude",
      CLAUDE_BIN: "/generic/claude",
      PATH: "/path/bin",
    }, (path) => { checked.push(path); }));

    expect(checked).toEqual(["/sigil/claude"]);
    expect(agent.runtime?.providerSessionId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  test("falls back from CLAUDE_BIN to PATH only when no override is selected", () => {
    const checked: string[] = [];
    createClaudePtyAgent(binding, "/repo", subscription, {}, constructionDependencies({
      CLAUDE_BIN: "/generic/claude",
      PATH: "/path/bin",
    }, (path) => { checked.push(path); }));

    expect(checked).toEqual(["/generic/claude"]);
  });

  test("reports a missing selected executable as invalid_request without spawning", () => {
    let spawned = false;
    expect(() => createClaudePtyAgent(binding, "/repo", subscription, {}, {
      ...constructionDependencies({ SIGIL_CLAUDE_PTY_BIN: "/missing" }, () => {
        throw new Error("not executable");
      }),
      spawn: async () => { spawned = true; throw new Error("must not spawn"); },
    })).toThrow("unavailable");

    try {
      createClaudePtyAgent(binding, "/repo", subscription, {}, constructionDependencies(
        { SIGIL_CLAUDE_PTY_BIN: "/missing" },
        () => { throw new Error("not executable"); },
      ));
    } catch (error) {
      expect(classifyProviderFailure(error).code).toBe("invalid_request");
    }
    expect(spawned).toBe(false);
  });

  test("allows turn completion to exceed the transport startup timeout", async () => {
    let now = 0;
    let promptWritten = false;
    let argumentsPassed: string[] = [];
    const agent = createClaudePtyAgent(binding, "/repo", subscription, {}, {
      ...constructionDependencies({ SIGIL_CLAUDE_PTY_BIN: "/claude" }, () => {}),
      promptSubmitDelayMs: 0,
      now: () => now,
      sleep: async () => { now += 1_000; },
      readTranscript: async () => promptWritten && now > 10_000
        ? transcript("question", "answer")
        : "",
      spawn: async (options) => {
        argumentsPassed = options.args ?? [];
        options.onData?.(new TextEncoder().encode("Claude Code ? for shortcuts"));
        return {
          write: () => { promptWritten = true; return 1; },
          close: async () => {},
          wait: async () => await new Promise<number>(() => {}),
        };
      },
    });

    await expect(agent.prompt("question")).resolves.toBe("answer");
    expect(argumentsPassed).toContain("--dangerously-skip-permissions");
    expect(argumentsPassed).not.toContain("--permission-mode");
  });

  test("waits past a thinking-only end-turn record for Claude's text response", async () => {
    let reads = 0;
    let promptWritten = false;
    const agent = createClaudePtyAgent(binding, "/repo", subscription, {}, {
      ...constructionDependencies({ SIGIL_CLAUDE_PTY_BIN: "/claude" }, () => {}),
      promptSubmitDelayMs: 0,
      readTranscript: async () => {
        if (!promptWritten) return "";
        reads += 1;
        const records = [
          JSON.stringify({ type: "user", message: { role: "user", content: "question" } }),
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" },
          }),
        ];
        if (reads > 2) {
          records.push(JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" },
          }));
        }
        return records.join("\n");
      },
      spawn: async (options) => {
        options.onData?.(new TextEncoder().encode("Claude Code ? for shortcuts"));
        return {
          write: () => { promptWritten = true; return 1; },
          close: async () => {},
          wait: async () => await new Promise<number>(() => {}),
        };
      },
    });

    await expect(agent.prompt("question")).resolves.toBe("answer");
  });

  test("retries a prompt that the Claude terminal does not initially accept", async () => {
    let now = 0;
    let submissions = 0;
    let pendingPrompt = "";
    const writes: string[] = [];
    const agent = createClaudePtyAgent(binding, "/repo", subscription, {}, {
      ...constructionDependencies({ SIGIL_CLAUDE_PTY_BIN: "/claude" }, () => {}),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds || 1; },
      promptSubmitDelayMs: 1,
      promptAcceptanceTimeoutMs: 5,
      promptAcceptanceRetries: 2,
      readTranscript: async () => submissions >= 2
        ? transcript("question", "answer")
        : "",
      spawn: async (options) => {
        options.onData?.(new TextEncoder().encode("Claude Code ? for shortcuts"));
        return {
          write: (value) => {
            if (typeof value !== "string") throw new TypeError("expected a string terminal write");
            writes.push(value);
            if (value === "\r") submissions += 1;
            else pendingPrompt = value;
            return value.length;
          },
          close: async () => {},
          wait: async () => await new Promise<number>(() => {}),
        };
      },
    });

    await expect(agent.prompt("question")).resolves.toBe("answer");
    expect(pendingPrompt).toBe("question");
    expect(submissions).toBe(2);
    expect(writes).toEqual(["question", "\r", "question", "\r"]);
  });

  test("classifies authentication failures displayed after readiness", async () => {
    let onData: ((data: Uint8Array) => void) | undefined;
    const agent = createClaudePtyAgent(binding, "/repo", subscription, {}, {
      ...constructionDependencies({ SIGIL_CLAUDE_PTY_BIN: "/claude" }, () => {}),
      now: () => 0,
      sleep: async () => {
        onData?.(new TextEncoder().encode("Not logged in · Run /login"));
      },
      readTranscript: async () => "",
      spawn: async (options) => {
        onData = options.onData;
        onData?.(new TextEncoder().encode("Claude Code ? for shortcuts"));
        return {
          write: () => 1,
          close: async () => {},
          wait: async () => await new Promise<number>(() => {}),
        };
      },
    });

    try {
      await agent.prompt("question");
      throw new Error("expected authentication failure");
    } catch (error) {
      expect(classifyProviderFailure(error).code).toBe("authentication_failed");
    }
  });
});

function transcript(user: string, assistant: string): string {
  return [
    JSON.stringify({ type: "user", message: { role: "user", content: user } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: assistant, stop_reason: "end_turn" },
    }),
  ].join("\n");
}
