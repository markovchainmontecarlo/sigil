import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { BACKLOG_CONTRACT_VERSION, checkBacklog, orderItems, type Backlog } from "../src/contracts/backlog.js";
import { createContext } from "../src/context.js";
import { breakdownPrompts } from "../src/workflows/breakdown/prompts.js";
import { breakdown } from "../src/workflows/breakdown/index.js";

class StubAgent implements SigilAgent {
  calls: string[] = [];
  closed = false;
  constructor(private readonly action: (call: number, prompt: string) => string | void | Promise<string | void> = () => {}) {}

  async prompt(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return (await this.action(this.calls.length, prompt)) ?? "";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function tempRepo(planners = ["planner-a"], synthesizer = "synthesizer"): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-breakdown-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: Object.fromEntries([...planners, synthesizer].map((name) => [name, { provider: "codex", model: "gpt-5.5" }])),
    evals: {},
    plan: { planners, synthesizer, reviewer: synthesizer, semanticReviewLimit: 2 },
    implement: { coder: planners[0], sessionTaskLimit: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: [synthesizer], synthesizer: synthesizer },
  }, null, 2));
  return dir;
}

function validBacklog(): Backlog {
  return {
    contractVersion: BACKLOG_CONTRACT_VERSION,
    mission: "break down fixture",
    items: [
      { id: "setup", goal: "Prepare the shared contract.", dependsOn: [], brief: "Prepare the shared contract with clear constraints and acceptance so later work can rely on it." },
      { id: "consumer", goal: "Use the shared contract.", dependsOn: ["setup"], brief: "Use the shared contract after setup, preserving the public behavior and checking the consumer outcome." },
    ],
  };
}

function invalidBacklog(): object {
  return {
    contractVersion: BACKLOG_CONTRACT_VERSION,
    mission: "break down fixture",
    items: [
      { id: "setup", goal: "Prepare the shared contract.", dependsOn: [], brief: "" },
      { id: "consumer", goal: "Use the shared contract.", dependsOn: ["missing"], brief: "Use the shared contract." },
    ],
  };
}

function firstPathAfter(prompt: string, marker: string): string {
  const index = prompt.indexOf(marker);
  if (index < 0) throw new Error(`missing marker ${marker}`);
  const match = prompt.slice(index).match(/\s(\/\S+\.(?:md|json))/);
  if (!match) throw new Error(`missing path after ${marker}`);
  return match[1];
}

function writeCutAgent(text: string): StubAgent {
  return new StubAgent((_call, prompt) => {
    writeFileSync(firstPathAfter(prompt, "to"), text);
  });
}

function synthAgent(opts: { invalidFirst?: boolean } = {}): { agent: StubAgent; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const agent = new StubAgent((call, prompt) => {
    if (call === 1) {
      files.backlog = firstPathAfter(prompt, "to");
      writeFileSync(files.backlog, JSON.stringify(opts.invalidFirst ? invalidBacklog() : validBacklog(), null, 2));
    }
    if (call === 2 && !opts.invalidFirst) {
      writeFileSync(files.backlog, `${JSON.stringify(validBacklog(), null, 2)}\n`);
    }
    if (call === 3 && opts.invalidFirst) {
      writeFileSync(files.backlog, `${JSON.stringify(validBacklog(), null, 2)}\n`);
    }
  });
  return { agent, files };
}

function testContext(repo: string, agents: Record<string, StubAgent>) {
  return createContext(repo, { createAgent: (binding) => agents[binding as string] });
}

describe("breakdown", () => {
  test("two planners produce a valid ordered backlog under local run storage", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    rmSync(join(repo, ".sigil", "runs"), { recursive: true, force: true });
    const plannerA = writeCutAgent("- setup: prepare contract\n- consumer: depends on setup\n");
    const plannerB = writeCutAgent("- setup: same boundary\n- consumer: same dependency\n");
    const synth = synthAgent();

    const result = await breakdown(
      { repo, mission: "break down fixture" },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    const raw = JSON.parse(await readFile(result.backlogFile, "utf8"));
    const checked = checkBacklog(raw);
    const ordered = orderItems(checked.backlog!);
    const ids = checked.backlog!.items.map((item) => item.id);

    expect(result.valid).toBe(true);
    expect(result.itemCount).toBe(2);
    expect(result.backlogFile.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
    expect(synth.files.backlog.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
    expect(checked.errors).toEqual([]);
    expect(ids).toEqual(ordered.map((item) => item.id));
    expect(synth.agent.calls[0]).toContain("planner 1: planner-a");
    expect(synth.agent.calls[0]).toContain("planner 2: planner-b");
    expect(synth.agent.calls[1]).toContain("BACKLOG:");
  });

  test("repairs an invalid first backlog emission through the bounded fix-json loop", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writeCutAgent("CUT A");
    const plannerB = writeCutAgent("CUT B");
    const synth = synthAgent({ invalidFirst: true });

    const result = await breakdown(
      { repo, mission: "break down fixture", outFile: join(repo, "backlog.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(result.issues.join("\n")).toContain("backlog repair ran");
    expect(synth.agent.calls).toHaveLength(3);
    expect(synth.agent.calls[2]).toContain("missing brief");
    expect(synth.agent.calls[2]).toContain("depends on unknown item: missing");
  });

  test("continues when one planner never writes its cut", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writeCutAgent("CUT A");
    const plannerB = new StubAgent();
    const synth = synthAgent();

    const result = await breakdown(
      { repo, mission: "break down fixture", outFile: join(repo, "backlog.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(result.issues.join("\n")).toContain("planner 1 (planner-b) failed");
    expect(synth.agent.calls[0]).toContain("CUT A");
    expect(synth.agent.calls[0]).not.toContain("planner-b");
  });

  test("breakdown prompts exist and interpolate only supplied variables", () => {
    const vars = {
      MISSION: "mission",
      CUTS: "cuts",
      OUT_FILE: "/tmp/backlog.json",
      FILE: "/tmp/backlog.json",
      CONTRACT: "contract",
      BACKLOG: "backlog",
      ERRORS: "errors",
    };

    for (const name of ["cut", "merge", "briefs", "fixJson"]) {
      expect(existsSync(join("src", "workflows", "breakdown", "prompts", `${name}.md`))).toBe(true);
      expect(breakdownPrompts[name](vars)).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  test("diagram documents planner parallelism, synthesis, repair, and ordering", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/breakdown/workflow.mermaid"), "utf8");

    expect(diagram).toContain("Run configured planners in parallel");
    expect(diagram).toContain("configured synthesizer role");
    expect(diagram).toContain("Enrich backlog item briefs");
    expect(diagram).toContain("Repair backlog JSON with breakdown prompt");
    expect(diagram).toContain("Order backlog items by dependencies");
  });
});
