import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { emit, evalGate } from "../src/gate.js";
import type { SigilAgent } from "../src/agents.js";
import { processIdentityIsAlive, readProcessIdentity } from "../src/process-identity.js";

class StubAgent implements SigilAgent {
  calls: string[] = [];
  constructor(private readonly action: (call: number, prompt: string) => void | Promise<void> = () => {}) {}

  async prompt(prompt: string): Promise<string> {
    this.calls.push(prompt);
    await this.action(this.calls.length, prompt);
    return "";
  }

  async close(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sigil-gate-test-"));
}

function longContent(label: string): string {
  return `${label} ${"x".repeat(80)}\n`;
}

describe("emit", () => {
  test("returns a named missing issue after the corrective budget is exhausted", async () => {
    const dir = tempDir();
    const file = join(dir, "missing.md");
    const agent = new StubAgent();

    const result = await emit(agent, "write missing.md", file, { attempts: 1, minBytes: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected emit to fail");
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[0]).toBe("write missing.md");
    expect(agent.calls[1]).toContain("Your previous turn failed its artifact gate:");
    expect(result.issue).toContain(file);
    expect(result.issue).toContain("missing");
  });

  test("returns content when a corrective retry writes the file", async () => {
    const dir = tempDir();
    const file = join(dir, "out.md");
    const content = longContent("created");
    const agent = new StubAgent((call) => {
      if (call === 2) writeFileSync(file, content);
    });

    const result = await emit(agent, "write out.md", file, { attempts: 1, minBytes: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issue);
    expect(result.contents).toEqual([content]);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[0]).toBe("write out.md");
    expect(agent.calls[1]).toContain(`${file} is missing`);
  });

  test("requires a pre-existing file to change", async () => {
    const dir = tempDir();
    const file = join(dir, "stale.md");
    writeFileSync(file, longContent("stale"));
    const agent = new StubAgent();

    const result = await emit(agent, "rewrite stale.md", file, { attempts: 1, minBytes: 5, mustChange: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected emit to fail");
    expect(result.issue).toContain(file);
    expect(result.issue).toContain("byte-identical");
    expect(agent.calls[1]).toContain("byte-identical");
  });

  test("accepts a changed pre-existing file", async () => {
    const dir = tempDir();
    const file = join(dir, "changed.md");
    writeFileSync(file, longContent("before"));
    const changed = longContent("after");
    const agent = new StubAgent(() => writeFileSync(file, changed));

    const result = await emit(agent, "rewrite changed.md", file, { minBytes: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issue);
    expect(result.contents).toEqual([changed]);
    expect(agent.calls).toHaveLength(1);
  });
});

const config = {
  agents: {
    explorer: { provider: "codex", model: "gpt-5.5", effort: "medium" },
    implementer: { provider: "codex", model: "gpt-5.5", effort: "medium" },
    reviewer: { provider: "codex", model: "gpt-5.5" },
  },
  evals: {
    build: "cat fixture-marker.txt",
    failing: "node -e \"console.log('setup ok\\n'.repeat(4000) + 'ERROR boom\\n' + 'tail ok\\n'.repeat(4000)); process.exit(7)\"",
    cancellable: "node process-tree.mjs",
  },
  plan: { planners: ["explorer"], synthesizer: "explorer", reviewer: "explorer" },
  implement: { coder: "implementer", sessionTaskLimit: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
  review: { reviewers: ["reviewer"], synthesizer: "reviewer" },
};

function repoWithConfig(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, "fixture-marker.txt"), "build ok from fixture\n");
  writeFileSync(join(dir, "process-tree.mjs"), `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync("descendant.pid", String(child.pid));
    setInterval(() => {}, 1000);
  `);
  return dir;
}

describe("evalGate", () => {
  test("runs a configured command and returns ok by exit code", async () => {
    const dir = repoWithConfig();

    const result = await evalGate("build", { cwd: dir });

    expect(result.ok).toBe(true);
    if (result.skipped) throw new Error("expected configured eval to run");
    expect(result.log).toContain("build ok from fixture");
  });

  test("skips an unconfigured command without executing anything", async () => {
    const dir = repoWithConfig();

    const result = await evalGate("nonexistent", { cwd: dir });

    expect(result).toEqual({ ok: true, skipped: true });
  });

  test("compresses failing command logs around failure lines", async () => {
    const dir = repoWithConfig();

    const result = await evalGate("failing", { cwd: dir });

    expect(result.ok).toBe(false);
    if (result.skipped) throw new Error("expected configured eval to run");
    expect(result.log).toContain("ERROR boom");
    expect(result.log).toContain("=== failure lines (extracted) ===");
  });

  test("cancellation removes gate descendants before returning", async () => {
    const dir = repoWithConfig();
    const pidFile = join(dir, "descendant.pid");
    const abort = new AbortController();
    const running = evalGate("cancellable", { cwd: dir, signal: abort.signal });
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    const descendant = await readProcessIdentity(Number(readFileSync(pidFile, "utf8")));

    abort.abort();
    const result = await running;

    expect(result.ok).toBe(false);
    expect(await processIdentityIsAlive(descendant)).toBe(false);
  });
});
