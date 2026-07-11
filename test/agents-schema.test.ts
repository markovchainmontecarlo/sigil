import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createClaudeAgentFromGenerate, createCodexAgentFromGenerate, createCopilotAgentFromClient, createCopilotAgentFromGenerate, isSchemaPromptError } from "../src/agents.js";

describe("schema prompts", () => {
  test("claude schema prompt preserves warm continuation", async () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const calls: Array<{ text: string; options?: Record<string, unknown> }> = [];
    const agent = createClaudeAgentFromGenerate(async <T>(text: string, options?: Record<string, unknown>) => {
      calls.push({ text, options });
      return calls.length === 1 ? { text: "ignored", object: { name: "ok", count: 2 } as T } : { text: "second" };
    });

    const value = await agent.prompt("return an object", schema);
    const second = await agent.prompt("plain follow-up");

    expect(value).toEqual({ name: "ok", count: 2 });
    expect(second).toBe("second");
    expect(calls[0].options).toEqual({ structuredOutput: { schema } });
    expect(calls[1].options).toEqual({ sdkOptions: { continue: true } });
  });

  test("claude schema prompt validates the returned object", async () => {
    const agent = createClaudeAgentFromGenerate(async <T>() => ({
      text: "ignored",
      object: { count: "wrong" } as T,
    }));

    let caught: unknown;
    try {
      await agent.prompt("return a count", z.object({ count: z.number() }));
    } catch (error) {
      caught = error;
    }

    expect(isSchemaPromptError(caught)).toBe(true);
  });

  test("schema-valid", async () => {
    const agent = createCodexAgentFromGenerate(async () => JSON.stringify({ name: "codex", count: 1 }));

    const value = await agent.prompt("return an object", z.object({ name: z.string(), count: z.number() }));

    expect(value).toEqual({ name: "codex", count: 1 });
  });

  test("schema-invalid-then-reask", async () => {
    const turns: string[] = [];
    const agent = createCodexAgentFromGenerate(async (prompt) => {
      turns.push(prompt);
      return turns.length === 1 ? "not json" : JSON.stringify({ ok: true });
    });

    const value = await agent.prompt("return a flag", z.object({ ok: z.boolean() }));

    expect(value).toEqual({ ok: true });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain("return a flag");
    expect(turns[1]).toContain("failed its schema gate");
    expect(turns[1]).toContain("invalid JSON");
  });

  test("exhausted-invalid", async () => {
    const agent = createCodexAgentFromGenerate(async () => JSON.stringify({ count: "wrong" }));

    let caught: unknown;
    try {
      await agent.prompt("return a count", z.object({ count: z.number() }));
    } catch (error) {
      caught = error;
    }

    expect(isSchemaPromptError(caught)).toBe(true);
    if (!isSchemaPromptError(caught)) throw new Error("expected SchemaPromptError");
    expect(caught.issue).toContain("schema invalid");
  });

  test("text-prompt unchanged", async () => {
    const turns: string[] = [];
    const agent = createCodexAgentFromGenerate(async (prompt) => {
      turns.push(prompt);
      return "not json";
    });

    const value = await agent.prompt("plain text");

    expect(value).toBe("not json");
    expect(turns).toEqual(["plain text"]);
  });

  test("copilot schema prompt uses json retry", async () => {
    const turns: string[] = [];
    const agent = createCopilotAgentFromGenerate(async (prompt) => {
      turns.push(prompt);
      return turns.length === 1 ? "nope" : JSON.stringify({ provider: "copilot" });
    });

    const value = await agent.prompt("return provider", z.object({ provider: z.literal("copilot") }));

    expect(value).toEqual({ provider: "copilot" });
    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain("failed its schema gate");
  });

  test("copilot client adapter reuses one session and closes resources", async () => {
    const prompts: string[] = [];
    let createSessionCalls = 0;
    let disconnected = false;
    let stopped = false;
    const session = {
      async sendAndWait(options: string | { prompt: string }) {
        if (typeof options === "string") throw new Error("expected object prompt");
        prompts.push(options.prompt);
        return { data: { content: `reply ${prompts.length}` } } as never;
      },
      async disconnect() {
        disconnected = true;
      },
    };
    const client = {
      async createSession(config: unknown) {
        createSessionCalls++;
        expect(config).toMatchObject({
          model: "gpt-5",
          reasoningEffort: "medium",
          workingDirectory: "/repo",
        });
        return session;
      },
      async stop() {
        stopped = true;
        return [];
      },
    };
    const agent = createCopilotAgentFromClient(client, { provider: "copilot", model: "gpt-5", effort: "medium" }, "/repo");

    await expect(agent.prompt("first")).resolves.toBe("reply 1");
    await expect(agent.prompt("second")).resolves.toBe("reply 2");
    await agent.close();

    expect(createSessionCalls).toBe(1);
    expect(prompts).toEqual(["first", "second"]);
    expect(disconnected).toBe(true);
    expect(stopped).toBe(true);
  });
});
