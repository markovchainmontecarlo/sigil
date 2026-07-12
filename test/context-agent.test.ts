import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { SchemaPromptError, type SigilAgent } from "../src/agents.js";
import type { AgentBinding } from "../src/config.js";
import { createContext, wrapAgentForContext } from "../src/context.js";

class FakeAgent implements SigilAgent {
  calls: string[] = [];
  closed = false;
  constructor(private readonly action: (call: number, prompt: string, schema?: unknown) => string | void | Promise<string | void> = () => {}) {}

  async prompt<T>(prompt: string, schema?: z.ZodType<T>): Promise<string | T> {
    this.calls.push(prompt);
    const result = await this.action(this.calls.length, prompt, schema);
    return (result ?? "") as string | T;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-context-agent-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "gpt-5.5" } },
    evals: {},
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  }, null, 2));
  return dir;
}

function writeFromPrompt(prompt: string, name: string, contents: string): void {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prompt.match(new RegExp(`- ${escaped}: (\\S+)`));
  if (!match) throw new Error(`missing generated write target for ${name}`);
  mkdirSync(dirname(match[1]), { recursive: true });
  writeFileSync(match[1], contents);
}

describe("context rich agent", () => {
  test("writes-single returns artifact content and prompts with name and resolved path", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo, {
      createAgent: () => new FakeAgent((_call, prompt) => writeFromPrompt(prompt, "answer.md", "single content that clears the gate\n")),
    });

    const result = await ctx.agent("coder").prompt("write the answer", { writes: "answer.md", minBytes: 5 });

    expect(result).toBe("single content that clears the gate\n");
  });

  test("writes-single generated prompt names the artifact and absolute target", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const base = new FakeAgent((_call, prompt) => writeFromPrompt(prompt, "answer.md", "single content that clears the gate\n"));
    const agent = wrapAgentForContext(base, { artifactPath: ctx.artifacts.path, issue: ctx.issue.bind(ctx) });

    const result = await agent.prompt("write the answer", { writes: "answer.md", minBytes: 5 });

    expect(result).toBe("single content that clears the gate\n");
    expect(base.calls[0]).toContain("answer.md");
    expect(base.calls[0]).toContain(ctx.artifacts.path("answer.md"));
  });

  test("writes-multiple returns contents keyed by artifact name", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const base = new FakeAgent((_call, prompt) => {
      writeFromPrompt(prompt, "one.md", "one content that clears the gate\n");
      writeFromPrompt(prompt, "two.md", "two content that clears the gate\n");
    });
    const agent = wrapAgentForContext(base, { artifactPath: ctx.artifacts.path, issue: ctx.issue.bind(ctx) });

    const result = await agent.prompt("write both", { writes: ["one.md", "two.md"], minBytes: 5 });

    expect(result).toEqual({ "one.md": "one content that clears the gate\n", "two.md": "two content that clears the gate\n" });
  });

  test("write-failure issue recording", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const agent = wrapAgentForContext(new FakeAgent(), { artifactPath: ctx.artifacts.path, issue: ctx.issue.bind(ctx) });

    const result = await agent.prompt("write nothing", { writes: "missing.md", attempts: 0, minBytes: 5 });

    expect(result).toBe("");
    expect(ctx.issues).toHaveLength(1);
    expect(ctx.issues[0]).toStartWith("agent writes failed (missing.md):");
    expect(ctx.issues[0]).toContain("missing");
  });

  test("multiple write gate failure returns empty object", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const agent = wrapAgentForContext(new FakeAgent(), { artifactPath: ctx.artifacts.path, issue: ctx.issue.bind(ctx) });

    const result = await agent.prompt("write nothing", { writes: ["a.md", "b.md"], attempts: 0, minBytes: 5 });

    expect(result).toEqual({});
    expect(ctx.issues[0]).toStartWith("agent writes failed (a.md, b.md):");
  });

  test("schema-failure issue recording", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const agent = wrapAgentForContext(new FakeAgent(() => { throw new SchemaPromptError("bad schema"); }), {
      artifactPath: ctx.artifacts.path,
      issue: ctx.issue.bind(ctx),
    });

    await expect(agent.prompt("return json", z.object({ ok: z.boolean() }))).rejects.toThrow(SchemaPromptError);
    expect(ctx.issues).toEqual(["schema prompt failed: schema prompt failed: bad schema"]);
  });

  test("inline binding", async () => {
    const repo = tempRepo();
    const seen: Array<string | AgentBinding> = [];
    const ctx = createContext(repo, {
      createAgent: (binding) => {
        seen.push(binding);
        return new FakeAgent(() => "ok");
      },
    });

    await expect(ctx.agent({ provider: "codex", model: "gpt-5.5" }).prompt("inline")).resolves.toBe("ok");
    await expect(ctx.agent("coder").prompt("named")).resolves.toBe("ok");

    expect(seen).toEqual([{ provider: "codex", model: "gpt-5.5" }, "coder"]);
  });

  test("withAgent closes the agent after a successful callback", async () => {
    const repo = tempRepo();
    const fake = new FakeAgent(() => "ok");
    const ctx = createContext(repo, { createAgent: () => fake });

    const result = await ctx.withAgent("coder", async (agent) => agent.prompt("work"));

    expect(result).toBe("ok");
    expect(fake.closed).toBe(true);
  });

  test("withAgent closes the agent when the callback throws and preserves the error", async () => {
    const repo = tempRepo();
    const fake = new FakeAgent(() => "unused");
    const ctx = createContext(repo, { createAgent: () => fake });
    const original = new Error("callback failed");

    await expect(ctx.withAgent("coder", async () => {
      throw original;
    })).rejects.toBe(original);

    expect(fake.closed).toBe(true);
  });
});
