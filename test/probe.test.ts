import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { z } from "zod";

import type { SigilAgent } from "../src/agents.js";
import { CONTRACT_VERSION, validateTaskGraph } from "../src/contracts/task-graph.js";
import { createContext } from "../src/context.js";
import { changedPaths } from "../src/git.js";
import { probePlan } from "../src/workflows/probe/index.js";

class ProbeStubAgent implements SigilAgent {
  calls: string[] = [];
  taskFile = "";

  constructor(private readonly opts: { invalidFirst?: boolean; repairs?: boolean } = {}) {}

  async prompt<T>(prompt: string, schema?: z.ZodType<T>): Promise<string | T> {
    this.calls.push(prompt);
    if (schema) return schema.parse({
      probes: [
        {
          id: "write-sandbox-marker",
          title: "Write sandbox marker",
          hypothesis: "Mutating probes stay in the sandbox clone.",
          command: "printf sandbox-only > sandbox-marker.txt && test -f sandbox-marker.txt",
          expected: "The command exits zero and writes only inside the sandbox.",
          mutates: true,
          rationale: "This proves probe mutation does not touch the target tree.",
        },
        {
          id: "read-sandbox-marker",
          title: "Read sandbox marker",
          hypothesis: "Later probes can observe earlier sandbox state.",
          command: "test -f sandbox-marker.txt",
          expected: "The marker exists in the sandbox clone.",
          mutates: false,
          rationale: "This proves probe commands share the sandbox checkout.",
        },
      ],
    });

    const findingsFile = pathAfter(prompt, "findings as markdown to");
    if (findingsFile) writeFileSync(findingsFile, "# Findings\n\nConfirmed issue: sandbox probing works without dirtying target.\n");

    const taskFile = pathAfter(prompt, "JSON to");
    if (taskFile) {
      this.taskFile = taskFile;
      writeFileSync(taskFile, JSON.stringify(this.opts.invalidFirst ? invalidGraph() : validGraph(), null, 2));
    }

    if (this.taskFile && prompt.includes("failed deterministic contract validation") && this.opts.repairs !== false) {
      writeFileSync(this.taskFile, JSON.stringify(validGraph(), null, 2));
    }

    return "";
  }

  async close(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-probe-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: { planner: { provider: "codex", model: "gpt-5.5" }, synthesizer: { provider: "codex", model: "gpt-5.5" } },
    evals: {},
    context: [],
    plan: { planners: ["planner"], synthesizer: "synthesizer" },
    implement: { coder: "planner", sessionTaskLimit: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["synthesizer"], synthesizer: "synthesizer" },
  }, null, 2));
  writeFileSync(join(dir, "app.txt"), "hello\n");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "sigil@example.test"]);
  git(dir, ["config", "user.name", "Sigil Test"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function validGraph(): object {
  return {
    contractVersion: CONTRACT_VERSION,
    project: "probe-plan",
    goal: "improve probing",
    tasks: [{
      id: "task-a",
      title: "Task A",
      summary: "Modify app.txt based on confirmed probe findings.",
      dependencies: [],
      acceptanceCriteria: ["app.txt reflects the confirmed behavior"],
      diagrams: [],
      files: [{ path: "app.txt", action: "modify", details: ["Update app.txt based on probe findings"] }],
    }],
  };
}

function invalidGraph(): object {
  return {
    ...validGraph(),
    tasks: [{
      ...(validGraph() as { tasks: object[] }).tasks[0],
      files: [{ path: "../outside.txt", action: "modify", details: ["bad path"] }],
    }],
  };
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function pathAfter(prompt: string, marker: string): string | undefined {
  const index = prompt.indexOf(marker);
  if (index < 0) return undefined;
  return prompt.slice(index).match(/\s(\/\S+\.(?:md|json))/)?.[1];
}

describe("probePlan", () => {
  test("runs mutating probes in a sandbox and leaves the target tree clean", async () => {
    const repo = tempGitRepo();
    const agent = new ProbeStubAgent();
    const ctx = createContext(repo, { createAgent: () => agent });

    const result = await probePlan({ repo, intent: "find usage issues", maxProbes: 2 }, ctx);

    expect(result.valid).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(validateTaskGraph(JSON.parse(readFileSync(result.taskFile, "utf8")), { repoRoot: repo }).tasks).toHaveLength(1);
    expect(readFileSync(result.evidenceFile, "utf8")).toContain("write-sandbox-marker");
    expect(existsSync(join(result.sandboxDir, "sandbox-marker.txt"))).toBe(true);
    expect(existsSync(join(repo, "sandbox-marker.txt"))).toBe(false);
    expect(await changedPaths(repo)).toEqual([]);
  });

  test("uses task graph repair observations without retaining repaired issues", async () => {
    const repo = tempGitRepo();
    const agent = new ProbeStubAgent({ invalidFirst: true });
    const observations: Array<{ stage: string; details: Record<string, string> }> = [];
    const ctx = createContext(repo, {
      createAgent: () => agent,
      onObserve: async (stage, details) => {
        observations.push({ stage, details });
      },
    });

    const result = await probePlan({ repo, intent: "find usage issues", maxProbes: 2 }, ctx);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(observations.find((event) => event.stage === "task-graph-repair-started")?.details.taskGraph).toBe("probe task graph");
    expect(observations.find((event) => event.stage === "task-graph-repair-attempted")?.details.outcome).toBe("valid");
    expect(observations.find((event) => event.stage === "task-graph-repair-completed")?.details.outcome).toBe("valid");
  });

  test("keeps exhausted task graph repair as an active issue", async () => {
    const repo = tempGitRepo();
    const agent = new ProbeStubAgent({ invalidFirst: true, repairs: false });
    const observations: Array<{ stage: string; details: Record<string, string> }> = [];
    const ctx = createContext(repo, {
      createAgent: () => agent,
      onObserve: async (stage, details) => {
        observations.push({ stage, details });
      },
    });

    const result = await probePlan({ repo, intent: "find usage issues", maxProbes: 2 }, ctx);

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("probe task graph still invalid");
    expect(observations.find((event) => event.stage === "task-graph-repair-exhausted")?.details.errors).toContain("file path escapes repo root");
  });

  test("diagram documents sandbox and target-tree boundaries", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/probe/workflow.mermaid"), "utf8");

    expect(diagram).toContain("configured planner roles run in parallel");
    expect(diagram).toContain("sandbox command loop");
    expect(diagram).toContain("configured synthesizer role writes findings");
    expect(diagram).toContain("repair task graph JSON");
    expect(diagram).toContain("target changed paths unchanged");
  });
});
