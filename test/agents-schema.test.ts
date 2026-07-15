import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { agent } from "../src/agents.js";
import { createTextAgentFromGenerate, isSchemaPromptError } from "../src/agent.js";
import { createClaudeAgentFromGenerate } from "../src/providers/claude.js";
import { createCopilotAgentFromClient, createCopilotAgentFromGenerate } from "../src/providers/copilot.js";
import { codexProfileStore, writeCodexProfiles } from "../src/codex-profiles.js";

describe("schema prompts", () => {
  test("inline bindings pass through the common runtime schema", () => {
    expect(() => agent({ provider: "codex", model: "", effort: "medium" })).toThrow();
    expect(() => agent({ provider: "codex", model: "model", effort: "high" as "medium" })).toThrow();
    expect(() => agent({
      provider: "claude",
      model: "model",
      execution: { sandbox: "workspace-write" },
    })).toThrow("does not support requested sandbox workspace-write");
  });
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
    expect(calls[0].options).toMatchObject({ structuredOutput: { schema } });
    expect(calls[0].options?.sdkOptions).toMatchObject({ abortController: expect.any(AbortController) });
    expect(calls[1].options?.sdkOptions).toMatchObject({
      continue: true,
      abortController: expect.any(AbortController),
    });
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

  test("claude prompt forwards cancellation", async () => {
    let forwarded: AbortController | undefined;
    const claude = createClaudeAgentFromGenerate(async (_text, options) => {
      forwarded = (options?.sdkOptions as { abortController?: AbortController })?.abortController;
      return await new Promise(() => {});
    });
    const controller = new AbortController();

    void claude.promptWithOptions?.("wait", undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    expect(forwarded?.signal.aborted).toBe(true);
  });

  test("schema-valid", async () => {
    const agent = createTextAgentFromGenerate(async () => JSON.stringify({ name: "codex", count: 1 }));

    const value = await agent.prompt("return an object", z.object({ name: z.string(), count: z.number() }));

    expect(value).toEqual({ name: "codex", count: 1 });
  });

  test("schema-invalid-then-reask", async () => {
    const turns: string[] = [];
    const agent = createTextAgentFromGenerate(async (prompt) => {
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
    const agent = createTextAgentFromGenerate(async () => JSON.stringify({ count: "wrong" }));

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
    const agent = createTextAgentFromGenerate(async (prompt) => {
      turns.push(prompt);
      return "not json";
    });

    const value = await agent.prompt("plain text");

    expect(value).toBe("not json");
    expect(turns).toEqual(["plain text"]);
  });

  test("invalid routed Codex configuration does not start ACP", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-agent-configuration-"));
    const profiles = codexProfileStore(root);
    mkdirSync(join(root, "codex-profiles"), { recursive: true });
    writeFileSync(profiles.registryFile, JSON.stringify({
      version: 1,
      profiles: [{ name: "invalid", home: "", enabled: true, profileClass: "subscription" }],
    }));
    chmodSync(profiles.registryFile, 0o600);
    const previous = process.env.SIGIL_CODEX_ACP_BIN;
    process.env.SIGIL_CODEX_ACP_BIN = join(root, "must-not-start");
    const codex = agent({ provider: "codex", model: "test", effort: "medium" }, {
      profileStore: profiles,
      capacityReader: async () => ({ available: true, remainingPercentage: 80 }),
    });

    try {
      await expect(codex.prompt("invalid")).rejects.toThrow("configuration error");
    } finally {
      await codex.close();
      if (previous === undefined) delete process.env.SIGIL_CODEX_ACP_BIN;
      else process.env.SIGIL_CODEX_ACP_BIN = previous;
    }
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
      on() {
        return () => {};
      },
      async abort() {},
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

  test("copilot client adapter propagates cancellation and progress", async () => {
    let handler: ((event: { type: string }) => void) | undefined;
    let abortCalls = 0;
    let resolvePrompt: (() => void) | undefined;
    const session = {
      on(next: (event: { type: string }) => void) {
        handler = next;
        return () => { handler = undefined; };
      },
      async abort() {
        abortCalls++;
        resolvePrompt?.();
      },
      async sendAndWait() {
        await new Promise<void>((resolve) => { resolvePrompt = resolve; });
        return { data: { content: "stopped" } } as never;
      },
      async disconnect() {},
    };
    const client = {
      async createSession() { return session; },
      async stop() { return []; },
    };
    const copilot = createCopilotAgentFromClient(
      client as never,
      { provider: "copilot", model: "gpt-5", effort: "medium" },
      "/repo",
    );
    const controller = new AbortController();
    const progress: string[] = [];

    const prompt = copilot.promptWithOptions?.("wait", undefined, {
      signal: controller.signal,
      onProgress: (kind) => progress.push(kind),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    handler?.({ type: "assistant.message_delta" });
    controller.abort();
    await prompt;

    expect(abortCalls).toBe(1);
    expect(progress).toEqual(["text"]);
  });
});
