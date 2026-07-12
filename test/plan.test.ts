import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { CONTRACT_VERSION, validateTaskGraph } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import { plan } from "../src/workflows/software-change/planning/index.js";

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

function tempRepo(planners = ["planner-a"], synthesizer = "synthesizer", context: Array<{ path: string; update?: boolean }> = []): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-plan-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: Object.fromEntries([...planners, synthesizer].map((name) => [name, { provider: "codex", model: "gpt-5.5" }])),
    evals: {},
    context,
    plan: { planners, synthesizer },
    implement: { coder: planners[0], batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: [synthesizer], synthesizer: synthesizer },
  }, null, 2));
  return dir;
}

function validGraph(repo: string): object {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "fixture",
    goal: "change fixture",
    tasks: [{
      id: "task-a",
      title: "Task A",
      summary: "Modify app.txt.",
      dependencies: [],
      acceptanceCriteria: ["app.txt is updated"],
      diagrams: [],
      files: [{ path: join(repo, "app.txt"), action: "modify", details: ["Update line 1 in app.txt"] }],
    }],
  };
}

function invalidGraph(repo: string): object {
  return { ...validGraph(repo), tasks: [{ ...(validGraph(repo) as { tasks: object[] }).tasks[0], files: [{ path: "../outside.txt", action: "modify", details: ["bad path"] }] }] };
}

function firstPathAfter(prompt: string, marker: string): string {
  const index = prompt.indexOf(marker);
  if (index < 0) throw new Error(`missing marker ${marker}`);
  const match = prompt.slice(index).match(/\s(\/\S+\.(?:md|json))/);
  if (!match) throw new Error(`missing path after ${marker}`);
  return match[1];
}

function writePlanAgent(text: string): StubAgent {
  return new StubAgent((call, prompt) => {
    if (call === 1) return `investigated ${text}`;
    if (call === 2) writeFileSync(firstPathAfter(prompt, "to"), text);
  });
}

function synthAgent(repo: string, opts: { invalidFirst?: boolean; repairs?: boolean } = {}): { agent: StubAgent; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const contents = {
    convergence: "CONVERGENCE CONTENT",
    divergence: "DIVERGENCE CONTENT",
    convergenceVerified: "CONVERGENCE VERIFIED CONTENT",
    divergenceVerified: "DIVERGENCE VERIFIED CONTENT",
    resolved: "RESOLVED DIVERGENCE CONTENT",
  };
  const agent = new StubAgent((call, prompt) => {
    if (call === 1) {
      files.convergence = firstPathAfter(prompt, "convergence report");
      files.divergence = firstPathAfter(prompt, "divergence report");
      writeFileSync(files.convergence, contents.convergence);
      writeFileSync(files.divergence, contents.divergence);
    }
    if (call === 2) {
      files.convergenceVerified = firstPathAfter(prompt, "convergence verification");
      files.divergenceVerified = firstPathAfter(prompt, "divergence verification");
      writeFileSync(files.convergenceVerified, contents.convergenceVerified);
      writeFileSync(files.divergenceVerified, contents.divergenceVerified);
    }
    if (call === 3) {
      files.resolved = firstPathAfter(prompt, "resolution report");
      writeFileSync(files.resolved, contents.resolved);
    }
    if (call === 4) {
      files.task = firstPathAfter(prompt, "to");
      writeFileSync(files.task, JSON.stringify(opts.invalidFirst ? invalidGraph(repo) : validGraph(repo), null, 2));
    }
    if (call === 6 && opts.repairs !== false) writeFileSync(files.task, JSON.stringify(validGraph(repo), null, 2));
  });
  return { agent, files };
}

function fastPathSynthAgent(repo: string, opts: { invalidFirst?: boolean } = {}): { agent: StubAgent; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const agent = new StubAgent((call, prompt) => {
    if (call === 1) {
      files.task = firstPathAfter(prompt, "to");
      writeFileSync(files.task, JSON.stringify(opts.invalidFirst ? invalidGraph(repo) : validGraph(repo), null, 2));
    }
    if (call === 3) writeFileSync(files.task, JSON.stringify(validGraph(repo), null, 2));
  });
  return { agent, files };
}

function testContext(repo: string, agents: Record<string, StubAgent>, observations: Array<{ stage: string; details: Record<string, string> }> = []) {
  return createContext(repo, {
    createAgent: (binding) => agents[binding as string],
    onObserve: async (stage, details) => {
      observations.push({ stage, details });
    },
  });
}

describe("plan", () => {
  test("produces a valid task graph from scripted agents", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = writePlanAgent("PLAN B");
    const synth = synthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture", outFile: join(repo, "task-graph.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(result.taskCount).toBeGreaterThan(0);
    expect(validateTaskGraph(JSON.parse(await readFile(result.taskFile, "utf8"))).tasks).toHaveLength(1);
    expect(synth.agent.calls[1]).toContain("CONVERGENCE CONTENT");
    expect(synth.agent.calls[1]).not.toContain(synth.files.convergence);
    expect(synth.agent.calls[2]).toContain("DIVERGENCE VERIFIED CONTENT");
    expect(synth.agent.calls[2]).not.toContain(synth.files.divergenceVerified);
  });

  test("defaults every artifact inside ignored local run storage", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    rmSync(join(repo, ".sigil", "runs"), { recursive: true, force: true });
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = writePlanAgent("PLAN B");
    const synth = synthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture" },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(result.taskFile.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
    for (const file of Object.values(synth.files)) {
      expect(file.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
    }
  });

  test("clears stale work directory files before writing current run artifacts", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const outFile = join(repo, "task-graph.json");
    const workDir = join(dirname(outFile), ".sigil-plan");
    const stale = join(workDir, "plan-9.md");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(stale, "stale plan\n");
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = writePlanAgent("PLAN B");
    const synth = synthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture", outFile },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(workDir, "plan-0.md"))).toBe(true);
    expect(existsSync(join(workDir, "convergence.md"))).toBe(true);
  });

  test("continues when one planner never writes its plan", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = new StubAgent();
    const synth = fastPathSynthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture", outFile: join(repo, "task-graph.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.failures.some((failure) => failure.stage === "planning:planner:1")).toBe(true);
    expect(synth.agent.calls[0]).toContain("PLAN A");
  });

  test("single planner takes the fast path", async () => {
    const repo = tempRepo();
    const outFile = join(repo, "task-graph.json");
    const workDir = join(dirname(outFile), ".sigil-plan");
    const planner = writePlanAgent("PLAN A");
    const synth = fastPathSynthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture", outFile },
      testContext(repo, { "planner-a": planner, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(synth.agent.calls).toHaveLength(2);
    expect(synth.agent.calls.some((call) => call.includes("convergence report"))).toBe(false);
    expect(synth.agent.calls[0]).toContain("PLAN A");
    for (const file of ["convergence.md", "divergence.md", "convergence-verified.md", "divergence-verified.md", "divergence-resolved.md"]) {
      expect(existsSync(join(workDir, file))).toBe(false);
    }
  });

  test("repairs an invalid task graph in the synthesizer window", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = writePlanAgent("PLAN B");
    const synth = synthAgent(repo, { invalidFirst: true });
    const observations: Array<{ stage: string; details: Record<string, string> }> = [];

    const result = await plan(
      { repo, intent: "change fixture", outFile: join(repo, "task-graph.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }, observations),
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(observations.find((event) => event.stage === "task-graph-repair-started")?.details.errors).toContain("file path escapes repo root");
    expect(observations.find((event) => event.stage === "task-graph-repair-attempted")?.details.outcome).toBe("valid");
    expect(observations.find((event) => event.stage === "task-graph-repair-completed")?.details.outcome).toBe("valid");
    expect(synth.agent.calls).toHaveLength(6);
    expect(synth.agent.calls[5]).toContain("file path escapes repo root");
  });

  test("reports an issue only when task graph repair is exhausted", async () => {
    const repo = tempRepo(["planner-a", "planner-b"]);
    const plannerA = writePlanAgent("PLAN A");
    const plannerB = writePlanAgent("PLAN B");
    const synth = synthAgent(repo, { invalidFirst: true, repairs: false });
    const observations: Array<{ stage: string; details: Record<string, string> }> = [];

    const result = await plan(
      { repo, intent: "change fixture", outFile: join(repo, "task-graph.json") },
      testContext(repo, { "planner-a": plannerA, "planner-b": plannerB, synthesizer: synth.agent }, observations),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("task graph still invalid");
    expect(result.issues.join("\n")).not.toContain("task graph repair ran");
    expect(observations.find((event) => event.stage === "task-graph-repair-exhausted")?.details.errors).toContain("file path escapes repo root");
  });

  test("injects configured context into planner prompts", async () => {
    const repo = tempRepo(["planner-a"], "synthesizer", [{ path: "ARCHITECTURE.md", update: true }]);
    writeFileSync(join(repo, "ARCHITECTURE.md"), "Architecture fact\n");
    const planner = writePlanAgent("PLAN A");
    const synth = fastPathSynthAgent(repo);

    const result = await plan(
      { repo, intent: "change fixture", outFile: join(repo, "task-graph.json") },
      testContext(repo, { "planner-a": planner, synthesizer: synth.agent }),
    );

    expect(result.valid).toBe(true);
    expect(planner.calls[0]).toContain("ARCHITECTURE.md (update: true)");
    expect(planner.calls[0]).toContain("Architecture fact");
  });
});
