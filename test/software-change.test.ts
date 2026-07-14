import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createContext, type SigilContext } from "../src/context.js";
import { CONTRACT_VERSION } from "../src/contracts/task-graph.js";
import { implement, type ImplementInput, type ImplementResult } from "../src/workflows/software-change/implementation/index.js";
import { plan, type PlanInput, type PlanResult } from "../src/workflows/software-change/planning/index.js";
import { softwareChange } from "../src/workflows/software-change/workflow.js";

function resultPlan(overrides: Partial<PlanResult> = {}): PlanResult {
  return {
    taskFile: "/tmp/sigil-task-graph.json",
    taskCount: 1,
    valid: true,
    issues: [],
    failures: [],
    ...overrides,
  };
}

function resultImplementation(overrides: Partial<ImplementResult> = {}): ImplementResult {
  return {
    branch: "sigil/change",
    prBody: "## Issues\n- none\n",
    reviewBlocking: false,
    issues: [],
    failedTasks: [],
    noopTasks: [],
    ...overrides,
  };
}

function workflowContext(
  repo: string,
  seams: {
    plan: (input: PlanInput) => Promise<PlanResult>;
    implement: (input: ImplementInput) => Promise<ImplementResult>;
  },
): SigilContext {
  const base = createContext(repo);
  const ctx = Object.create(base) as SigilContext;
  ctx.run = async (child, input) => {
    if ((child as unknown) === plan) return seams.plan(input as PlanInput) as ReturnType<typeof child>;
    if ((child as unknown) === implement) return seams.implement(input as ImplementInput) as ReturnType<typeof child>;
    return child(input, ctx);
  };
  return ctx;
}

describe("softwareChange", () => {
  test("plans, passes the produced task graph artifact to implementation, and combines evidence", async () => {
    const repo = process.cwd();
    const calls: Array<{ stage: string; input: unknown }> = [];
    const planned = resultPlan({ taskFile: "/tmp/typed-task-graph.json", issues: ["plan caveat"] });
    const implemented = resultImplementation({ issues: ["implementation caveat"], noopTasks: ["already-done"] });

    const result = await softwareChange({
      repo,
      intent: "Make the change.",
      brief: "Preserve behavior.",
      instructions: "Read the architecture note first.",
      outFile: "/tmp/requested-task-graph.json",
      branch: "sigil/requested",
    }, workflowContext(repo, {
      plan: async (input) => {
        calls.push({ stage: "plan", input });
        return planned;
      },
      implement: async (input) => {
        calls.push({ stage: "implement", input });
        return implemented;
      },
    }));

    expect(calls).toEqual([
      { stage: "plan", input: { repo, intent: "Make the change.", brief: "Preserve behavior.", outFile: "/tmp/requested-task-graph.json" } },
      { stage: "implement", input: { repo, taskFile: "/tmp/typed-task-graph.json", branch: "sigil/requested", instructions: "Read the architecture note first." } },
    ]);
    expect(result.stage).toBe("implementation");
    expect(result.taskFile).toBe("/tmp/typed-task-graph.json");
    expect(result.taskCount).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.branch).toBe("sigil/change");
    expect(result.prBody).toContain("## Issues");
    expect(result.issues).toEqual(["plan caveat", "implementation caveat"]);
    expect(result.noopTasks).toEqual(["already-done"]);
  });



  test("passes caller-supplied task graph output through planning", async () => {
    const repo = process.cwd();
    const outFile = join(repo, "task-graph.json");
    const calls: Array<{ outFile?: string }> = [];

    const result = await softwareChange({
      repo,
      intent: "Make the change.",
      outFile,
    }, workflowContext(repo, {
      plan: async (input) => {
        calls.push({ outFile: input.outFile });
        return resultPlan({ taskFile: input.outFile });
      },
      implement: async () => resultImplementation(),
    }));

    expect(calls).toEqual([{ outFile }]);
    expect(result.taskFile).toBe(outFile);
  });

  test("accepted-graph resume bypasses planning and forwards checkpoint identity", async () => {
    const repo = process.cwd();
    const taskFile = join(repo, "task-graph.json");
    const canonicalGraphFile = join(repo, ".sigil", "canonical.json");
    const checkpointFile = join(repo, ".sigil", "checkpoint.json");
    const calls: string[] = [];
    const graph = {
      contractVersion: CONTRACT_VERSION, project: "resume", goal: "Resume implementation",
      architecture: "One task owns the resumed behavior.", constraints: [], nonGoals: [], tasks: [{
        id: "a", title: "A", summary: "A", dependencies: [], interfaces: { produces: [], consumes: [] },
        acceptanceCriteria: ["a"], verification: [{ kind: "command", command: "true", expected: "success" }], diagrams: [], files: [],
      }],
    };
    await Bun.write(taskFile, JSON.stringify(graph));
    try {
      await softwareChange({ repo, intent: "Resume", taskFile, canonicalGraphFile, checkpointFile, resume: true }, workflowContext(repo, {
        plan: async () => { calls.push("plan"); return resultPlan(); },
        implement: async (input) => {
          calls.push("implement");
          expect(input).toMatchObject({ taskFile, canonicalGraphFile, checkpointFile, resume: true });
          return resultImplementation();
        },
      }));
    } finally {
      rmSync(taskFile, { force: true });
    }
    expect(calls).toEqual(["implement"]);
  });

  test("marks implementation issues as invalid before delivery", async () => {
    const repo = process.cwd();

    const result = await softwareChange({ repo, intent: "Make the change." }, workflowContext(repo, {
      plan: async () => resultPlan(),
      implement: async () => resultImplementation({ issues: ["unresolved issue"] }),
    }));

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(["unresolved issue"]);
    expect(result.branch).toBe("sigil/change");
    expect(result.prBody).toContain("## Issues");
  });

  test("stops at an invalid plan and preserves the inspectable task graph result", async () => {
    const repo = process.cwd();
    const calls: string[] = [];
    const planned = resultPlan({ valid: false, taskFile: "/tmp/invalid-task-graph.json", taskCount: 0, issues: ["invalid graph"] });

    const result = await softwareChange({ repo, intent: "Make the change." }, workflowContext(repo, {
      plan: async () => {
        calls.push("plan");
        return planned;
      },
      implement: async () => {
        calls.push("implement");
        return resultImplementation();
      },
    }));

    expect(calls).toEqual(["plan"]);
    expect(result.stage).toBe("planning");
    expect(result.valid).toBe(false);
    expect(result.reviewBlocking).toBe(true);
    expect(result.taskFile).toBe("/tmp/invalid-task-graph.json");
    expect(result.implementation).toBeUndefined();
    expect(result.issues).toEqual(["invalid graph"]);
  });

  test("diagram documents the delivery boundary", () => {
    const diagram = readFileSync(join(process.cwd(), "src/workflows/software-change/workflow.mermaid"), "utf8");

    expect(diagram).toContain("configured planner roles run in parallel");
    expect(diagram).toContain("configured synthesizer role");
    expect(diagram).toContain("typed task graph artifact");
    expect(diagram).toContain("supplied task graph valid");
    expect(diagram).toContain("terminal workflow error: invalid supplied task graph");
    expect(diagram).toContain("terminal workflow error: dirty target tree");
    expect(diagram).toContain("task commit result");
    expect(diagram).toContain("record task commit failure issue");
    expect(diagram).toContain("same coder repairs no-change task");
    expect(diagram).toContain("noop-check agent verdict");
    expect(diagram).toContain("two consecutive unsatisfied noop checks");
    expect(diagram).toContain("commit final gate repair");
    expect(diagram).toContain("record final repair commit failure issue");
    expect(diagram).toContain("implementation-owned review stage");
    expect(diagram).toContain("no publish, push, pull request, or merge");
  });
});
