import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { agent, createClaudeAgentFromGenerate, createCodexAgentFromGenerate, createCopilotAgentFromClient, createCopilotAgentFromGenerate, isSchemaPromptError, monitorActiveCodexCapacity } from "../src/agents.js";
import { codexProfileStore, readCodexRoutingState, writeCodexProfiles } from "../src/codex-profiles.js";
import { releaseCodexProfile, reserveCodexProfile } from "../src/codex-router.js";

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

  test("blocked routed Codex admission does not start ACP", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-agent-admission-"));
    mkdirSync(root, { recursive: true });
    const profiles = codexProfileStore(root);
    await writeCodexProfiles([{
      name: "blocked",
      home: join(root, "codex-home"),
      enabled: true,
      profileClass: "subscription",
    }], profiles);
    const previous = process.env.SIGIL_CODEX_ACP_BIN;
    process.env.SIGIL_CODEX_ACP_BIN = join(root, "must-not-start");
    const codex = agent({ provider: "codex", model: "test", effort: "medium" }, {
      profileStore: profiles,
      capacityReader: async () => ({
        kind: "unknown",
        available: false,
        observedAt: new Date().toISOString(),
      }),
    });

    try {
      await expect(codex.prompt("blocked")).rejects.toThrow("capacity blocked");
    } finally {
      await codex.close();
      if (previous === undefined) delete process.env.SIGIL_CODEX_ACP_BIN;
      else process.env.SIGIL_CODEX_ACP_BIN = previous;
    }
  });

  test("invalid routed Codex configuration does not start ACP", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-agent-configuration-"));
    const profiles = codexProfileStore(root);
    mkdirSync(join(root, "codex-profiles"), { recursive: true });
    writeFileSync(profiles.registryFile, JSON.stringify({
      version: 1,
      profiles: [{ name: "invalid", home: "", enabled: true, profileClass: "subscription" }],
    }));
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

  test("active subscription protection cancels once and retains the reservation until release", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-active-capacity-"));
    const profiles = codexProfileStore(root);
    await writeCodexProfiles([{
      name: "protected",
      home: join(root, "codex-home"),
      enabled: true,
      profileClass: "subscription",
      reserveFloorPercentage: 20,
      activeCapacityPollIntervalMs: 5,
    }], profiles);
    const admission = await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), profiles);
    if (admission.status !== "assigned") throw new Error("expected assignment");
    const events: string[] = [];
    const telemetry: unknown[] = [];
    const guard = monitorActiveCodexCapacity(
      admission.assignment,
      async () => ({ available: true, remainingPercentage: 20 }),
      profiles,
      async (event) => {
        events.push("cancel");
        telemetry.push(event);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    await guard.stop();
    const activeState = await readCodexRoutingState(profiles);
    expect(events).toEqual(["cancel"]);
    expect(activeState.reservations[admission.assignment.reservation.id]).toBeDefined();
    expect(activeState.circuits.protected?.reason).toBe("capacity");
    expect(telemetry).toEqual([{
      profile: "protected",
      capacityClass: "at-or-below-floor",
      configuredFloor: 20,
      admissionOutcome: "assigned",
      capacityTriggeredCancellation: true,
    }]);

    await releaseCodexProfile(admission.assignment.reservation.id, undefined, profiles);
    expect(Object.keys((await readCodexRoutingState(profiles)).reservations)).toEqual([]);
    expect((await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), profiles)).status).toBe("assigned");
  });

  test("active subscription protection stops when a capacity observation never settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-active-capacity-stop-"));
    const profiles = codexProfileStore(root);
    await writeCodexProfiles([{
      name: "protected",
      home: join(root, "codex-home"),
      enabled: true,
      profileClass: "subscription",
      activeCapacityPollIntervalMs: 1,
    }], profiles);
    const admission = await reserveCodexProfile(async () => ({
      available: true,
      remainingPercentage: 80,
    }), profiles);
    if (admission.status !== "assigned") throw new Error("expected assignment");
    const guard = monitorActiveCodexCapacity(
      admission.assignment,
      () => new Promise(() => {}),
      profiles,
      async () => {},
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await guard.stop();
    await releaseCodexProfile(admission.assignment.reservation.id, undefined, profiles);

    expect(Object.keys((await readCodexRoutingState(profiles)).reservations)).toEqual([]);
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
