import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { createContext } from "../src/context.js";
import { artifactDir } from "../src/paths.js";
import { parseUnresolvedHigh, review } from "../src/workflows/software-change/review/index.js";

class StubAgent implements SigilAgent {
  calls: string[] = [];
  constructor(private readonly action: (call: number, prompt: string) => string | void = () => {}) {}

  async prompt(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.action(this.calls.length, prompt) ?? "";
  }

  async close(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function run(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "sigil-review-test-"));
  run(dir, ["init"]);
  run(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["config", "user.name", "Test User"]);
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: { reviewer: { provider: "codex", model: "gpt-5.5" } },
    evals: {},
    plan: { planners: ["reviewer"], synthesizer: "reviewer" },
    implement: { coder: "reviewer", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewer: "reviewer" },
  }, null, 2));
  writeFileSync(join(dir, "app.txt"), "before\n");
  run(dir, ["add", "."]);
  run(dir, ["commit", "-m", "initial"]);
  return { dir, base: run(dir, ["rev-parse", "HEAD"]).trim() };
}

function outFileFrom(prompt: string): string {
  const match = prompt.match(/Write your findings to (.+)\./);
  if (!match) throw new Error("review prompt did not name an output file");
  return match[1];
}

function writeFinding(prompt: string, text = "No findings."): void {
  writeFileSync(outFileFrom(prompt), text);
}

function changeTest(dir: string): void {
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "app.test.ts"), "expect(value).toBe(2);\n");
  run(dir, ["add", "."]);
  run(dir, ["commit", "-m", "change test"]);
}

describe("review", () => {
  test("returns without prompting on an empty diff", async () => {
    const { dir } = repo();
    const agent = new StubAgent();

    const result = await review({ repo: dir, base: "HEAD", autofix: true }, createContext(dir, { createAgent: () => agent }));

    expect(result.unresolvedHigh).toBe(0);
    expect(result.fixRan).toBe(false);
    expect(result.findings).toBe("");
    expect(agent.calls).toHaveLength(0);
  });

  test("runs findings and autofix on the same agent instance", async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, "app.txt"), "after\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "change"]);
    const findings = [
      "HIGH app.txt:1 first defect",
      "HIGH app.txt:1 second defect",
      "MEDIUM app.txt:1 narrow defect",
    ].join("\n");
    const agents: StubAgent[] = [];
    const agent = new StubAgent((call, prompt) => {
      if (call === 1) writeFileSync(outFileFrom(prompt), findings);
      if (call === 2) return "fixed one\nUNRESOLVED-HIGH: 1";
    });

    const result = await review({ repo: dir, base, autofix: true }, createContext(dir, {
      createAgent: () => {
        agents.push(agent);
        return agent;
      },
    }));

    expect(result.findings).toBe(findings);
    expect(result.unresolvedHigh).toBe(1);
    expect(result.fixRan).toBe(true);
    expect(agents).toEqual([agent]);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]).toContain(findings);
  });

  test("defaults findings outside the target working tree", async () => {
    const { dir, base } = repo();
    rmSync(artifactDir(dir), { recursive: true, force: true });
    writeFileSync(join(dir, "app.txt"), "after\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "change"]);
    const agent = new StubAgent((call, prompt) => {
      if (call === 1) writeFileSync(outFileFrom(prompt), "MEDIUM app.txt:1 narrow defect");
    });

    const result = await review({ repo: dir, base, autofix: false }, createContext(dir, { createAgent: () => agent }));

    expect(result.findings).toBe("MEDIUM app.txt:1 narrow defect");
    expect(relative(dir, result.findingsFile).startsWith("..")).toBe(true);
  });

  test("skips test-integrity reviewer when only non-test files changed", async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, "app.txt"), "after\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "change app"]);
    const agents: StubAgent[] = [];
    const findingsAgent = new StubAgent((call, prompt) => {
      if (call === 1) writeFinding(prompt);
    });

    const result = await review({ repo: dir, base, autofix: true }, createContext(dir, {
      createAgent: () => {
        agents.push(findingsAgent);
        return findingsAgent;
      },
    }));

    expect(result.unresolvedHigh).toBe(0);
    expect(result.issues).toEqual([]);
    expect(agents).toEqual([findingsAgent]);
    expect(findingsAgent.calls).toHaveLength(1);
  });

  test("blocks when the fresh test-integrity reviewer judges tests weakened", async () => {
    const { dir, base } = repo();
    changeTest(dir);
    const findingsAgent = new StubAgent((call, prompt) => {
      if (call === 1) writeFinding(prompt);
    });
    const integrityAgent = new StubAgent(() => "The assertion was edited to match behavior.\nWEAKENED: yes");
    const agents = [findingsAgent, integrityAgent];
    const created: StubAgent[] = [];

    const result = await review({ repo: dir, base, autofix: true }, createContext(dir, {
      createAgent: () => {
        const agent = agents.shift();
        if (!agent) throw new Error("unexpected agent");
        created.push(agent);
        return agent;
      },
    }));

    expect(result.unresolvedHigh).toBeGreaterThan(0);
    expect(result.issues).toContain("weakened-tests: changed tests were judged to weaken tests: test/app.test.ts");
    expect(created).toEqual([findingsAgent, integrityAgent]);
    expect(findingsAgent.calls).toHaveLength(1);
    expect(integrityAgent.calls).toHaveLength(1);
    expect(integrityAgent.calls[0]).toContain("expect(value).toBe(2);");
  });

  test("checks tests weakened by uncommitted autofix edits", async () => {
    const { dir } = repo();
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "app.test.ts"), "expect(value).toBe(1);\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "add test"]);
    const base = run(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "app.txt"), "after\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "change app"]);
    const findingsAgent = new StubAgent((call, prompt) => {
      if (call === 1) writeFinding(prompt, "HIGH app.txt:1 concrete defect");
      if (call === 2) {
        writeFileSync(join(dir, "test", "app.test.ts"), "expect(value).toBe(2);\n");
        return "fixed\nUNRESOLVED-HIGH: 0";
      }
    });
    const integrityAgent = new StubAgent(() => "The autofix weakened tests.\nWEAKENED: yes");
    const agents = [findingsAgent, integrityAgent];

    const result = await review({ repo: dir, base, autofix: true }, createContext(dir, {
      createAgent: () => {
        const agent = agents.shift();
        if (!agent) throw new Error("unexpected agent");
        return agent;
      },
    }));

    expect(result.unresolvedHigh).toBe(1);
    expect(result.issues).toContain("weakened-tests: changed tests were judged to weaken tests: test/app.test.ts");
    expect(findingsAgent.calls).toHaveLength(2);
    expect(integrityAgent.calls).toHaveLength(1);
    expect(integrityAgent.calls[0]).toContain("expect(value).toBe(2);");
  });

  test("does not block when the test-integrity reviewer judges tests not weakened", async () => {
    const { dir, base } = repo();
    changeTest(dir);
    const findingsAgent = new StubAgent((call, prompt) => {
      if (call === 1) writeFinding(prompt);
    });
    const integrityAgent = new StubAgent(() => "The phrase WEAKENED: yes appears in prose but the final verdict controls.\nWEAKENED: no");
    const agents = [findingsAgent, integrityAgent];
    const created: StubAgent[] = [];

    const result = await review({ repo: dir, base, autofix: true }, createContext(dir, {
      createAgent: () => {
        const agent = agents.shift();
        if (!agent) throw new Error("unexpected agent");
        created.push(agent);
        return agent;
      },
    }));

    expect(result.unresolvedHigh).toBe(0);
    expect(result.issues.some((issue) => issue.includes("weakened-tests"))).toBe(false);
    expect(created).toEqual([findingsAgent, integrityAgent]);
    expect(findingsAgent.calls).toHaveLength(1);
    expect(integrityAgent.calls).toHaveLength(1);
  });

  test("parses the unresolved high sentinel", () => {
    expect(parseUnresolvedHigh("done\nUNRESOLVED-HIGH: 12\n")).toBe(12);
    expect(parseUnresolvedHigh("UNRESOLVED-HIGH: none")).toBeUndefined();
  });
});
