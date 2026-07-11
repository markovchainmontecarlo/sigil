import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { createContext, type SigilContext } from "../src/context.js";
import type { EvalGateResult } from "../src/gate.js";
import { review, type ReviewInput, type ReviewResult } from "../src/workflows/software-change/review/index.js";
import { CONTRACT_VERSION, type Task, type TaskGraph } from "../src/contracts/task-graph.js";
import { artifactDir } from "../src/paths.js";
import { implement } from "../src/workflows/software-change/implementation/index.js";

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

function task(repo: string, id: string, dependencies: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    summary: `Change ${id}.`,
    dependencies,
    acceptanceCriteria: [`${id} works`],
    diagrams: [],
    files: [{ path: join(repo, `${id}.txt`), action: "modify", details: [`Update ${id}.txt line 1`] }],
  };
}

function fixture(tasks: Task[], opts: { batchSize?: number; baseBranch?: string; evals?: Record<string, string>; context?: Array<{ path: string; update?: boolean }>; contextFiles?: Record<string, string> } = {}): { repo: string; taskFile: string } {
  const repo = mkdtempSync(join(tmpdir(), "sigil-implement-test-"));
  run(repo, ["init"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  run(repo, ["config", "user.name", "Test User"]);
  const repoTasks = tasks.map((t) => ({ ...t, files: t.files.map((f) => ({ ...f, path: join(repo, basename(f.path)) })) }));
  for (const t of repoTasks) writeFileSync(t.files[0].path, `${t.id} before\n`);
  for (const [path, contents] of Object.entries(opts.contextFiles ?? {})) writeFileSync(join(repo, path), contents);
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "gpt-5.5" }, reviewer: { provider: "codex", model: "gpt-5.5" } },
    evals: opts.evals ?? { build: "build", test: "test", verify: "verify" },
    context: opts.context ?? [],
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", batchSize: opts.batchSize ?? 2, repairLimit: 2, branchPrefix: "impl/", baseBranch: opts.baseBranch ?? "master" },
    review: { reviewer: "reviewer" },
  }, null, 2));
  const graph: TaskGraph = { contractVersion: CONTRACT_VERSION, project: "fixture", goal: "test goal", tasks: repoTasks };
  const taskFile = join(repo, "task-graph.json");
  writeFileSync(taskFile, JSON.stringify(graph, null, 2));
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", "initial"]);
  run(repo, ["branch", "-M", opts.baseBranch ?? "master"]);
  return { repo, taskFile };
}

const okEval: (name: string) => Promise<EvalGateResult> = async () => ({ ok: true, log: "ok" });

type StubContextOptions = {
  createAgent: (binding?: Parameters<SigilContext["agent"]>[0]) => SigilAgent;
  evalGate?: (name: string) => Promise<EvalGateResult>;
  review?: (input: ReviewInput) => Promise<ReviewResult>;
};

function stubContext(repo: string, seams: StubContextOptions): SigilContext {
  const base = createContext(repo, { createAgent: (binding) => seams.createAgent(binding) });
  const ctx = Object.create(base) as SigilContext;
  ctx.evals = seams.evalGate ?? okEval;
  ctx.run = async (child, input) => {
    if ((child as unknown) === review) {
      const runReview = seams.review ?? (async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }));
      return runReview(input as ReviewInput) as ReturnType<typeof child>;
    }
    return child(input, ctx);
  };
  return ctx;
}

describe("implement", () => {
  test("runs a two-batch graph in task order and commits each task", async () => {
    const initial = fixture([]).repo;
    const tasks = [task(initial, "a"), task(initial, "b"), task(initial, "c")];
    const { repo, taskFile } = fixture(tasks, { batchSize: 2 });
    const seen: string[] = [];

    const result = await implement({ repo, taskFile, branch: "impl/happy" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) {
          seen.push(id);
          writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
        }
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.branch).toBe("impl/happy");
    expect(result.prBody).toContain("## Issues\n- none");
    expect(seen).toEqual(["a", "b", "c"]);
    expect(run(repo, ["log", "--oneline"]).split("\n").filter((line) => line.includes(": Task"))).toHaveLength(3);
  });

  test("injects run-specific instructions into task and review context", async () => {
    const initial = fixture([]).repo;
    const tasks = [task(initial, "a")];
    const { repo, taskFile } = fixture(tasks);
    const coder = new StubAgent((_call, prompt) => {
      const id = prompt.match(/## Your task: (\w+)/)?.[1];
      if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
    });
    let reviewContext = "";

    await implement({
      repo,
      taskFile,
      branch: "impl/instructions",
      instructions: "Before editing, read README.md and ARCHITECTURE.md.",
    }, stubContext(repo, {
      evalGate: okEval,
      createAgent: () => coder,
      review: async (input) => {
        reviewContext = input.context ?? "";
        return { valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] };
      },
    }));

    expect(coder.calls[0]).toContain("## Run instructions");
    expect(coder.calls[0]).toContain("Before editing, read README.md and ARCHITECTURE.md.");
    expect(reviewContext).toContain("## Run instructions");
    expect(reviewContext).toContain("Before editing, read README.md and ARCHITECTURE.md.");
  });

  test("implements a graph with repo-relative file paths", async () => {
    const initial = fixture([]).repo;
    const tasks = [task(initial, "a")];
    const { repo, taskFile } = fixture(tasks);
    const graph = JSON.parse(readFileSync(taskFile, "utf8")) as TaskGraph;
    graph.tasks[0].files[0].path = "a.txt";
    writeFileSync(taskFile, JSON.stringify(graph, null, 2));
    run(repo, ["add", "task-graph.json"]);
    run(repo, ["commit", "-m", "use relative task path"]);

    const result = await implement({ repo, taskFile, branch: "impl/relative-paths" }, stubContext(repo, {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.failedTasks).toEqual([]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a after\n");
  });

  test("red gates trigger repair in the same coder window and dependency failures are skipped", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a"), task(base, "b", ["a"]), task(base, "c")];
    const { repo, taskFile } = fixture(tasks, { batchSize: 3 });
    let buildCalls = 0;
    const coder = new StubAgent((_call, prompt) => {
      if (prompt.includes("Task c")) writeFileSync(join(repo, "c.txt"), "c after\n");
    });

    const result = await implement({ repo, taskFile, branch: "impl/red" }, stubContext(repo,
      {
      evalGate: async (name) => name === "build" && ++buildCalls > 1 && buildCalls <= 4 ? { ok: false, log: "red" } : { ok: true, log: "ok" },
      createAgent: () => coder,
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(coder.calls.some((call) => call.includes("failed build/test"))).toBe(true);
    expect(result.failedTasks).toContain("a");
    expect(result.failedTasks).toContain("b");
    expect(result.issues.join("\n")).toContain("skipped because a dependency failed");
  });

  test("no-op self-heal uses a fresh checker and satisfied verdict resets the tripwire", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks);
    const agents: StubAgent[] = [];

    const result = await implement({ repo, taskFile, branch: "impl/noop-ok" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => {
        const agent = new StubAgent((_call, prompt) => prompt.includes("NOOP-CHECK") ? "NOOP-CHECK: SATISFIED" : "");
        agents.push(agent);
        return agent;
      },
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.noopTasks).toEqual(["a"]);
    expect(result.issues.join("\n")).not.toContain("consecutive unexplained");
    expect(agents.length).toBeGreaterThan(1);
  });

  test("unsatisfied no-ops exhaust locally without stopping independent tasks", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a"), task(base, "b"), task(base, "c")];
    const { repo, taskFile } = fixture(tasks, { batchSize: 3 });

    const result = await implement({ repo, taskFile, branch: "impl/noop-stop" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => prompt.includes("NOOP-CHECK") ? "NOOP-CHECK: UNSATISFIED" : ""),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.noopTasks).toEqual([]);
    expect(result.failedTasks).toEqual(["a", "b", "c"]);
    expect(result.issues.join("\n")).not.toContain("consecutive unexplained no-ops");
  });

  test("rerunning the same graph on an existing branch resets to base first", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a"), task(base, "b")];
    const { repo, taskFile } = fixture(tasks, { baseBranch: "main" });
    run(repo, ["branch", "-M", "main"]);

    const makeCtx = () => stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    });

    await implement({ repo, taskFile, branch: "impl/fresh" }, makeCtx());
    await implement({ repo, taskFile, branch: "impl/fresh" }, makeCtx());

    const taskCommits = run(repo, ["log", "--oneline", "impl/fresh"]).split("\n").filter((line) => line.includes(": Task"));
    expect(taskCommits).toHaveLength(tasks.length);
    for (const t of tasks) expect(taskCommits.filter((line) => line.includes(`${t.id}: ${t.title}`))).toHaveLength(1);
  });

  test("task replies are persisted as run artifacts", async () => {
    const initial = fixture([]).repo;
    const tasks = [task(initial, "a"), task(initial, "b")];
    const { repo, taskFile } = fixture(tasks);
    const replyDir = join(artifactDir(repo), "implement-replies");
    rmSync(replyDir, { recursive: true, force: true });

    await implement({ repo, taskFile, branch: "impl/replies" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (!id) return "";
        writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
        return `did ${id} with a deviation note`;
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    for (const t of tasks) {
      expect(readFileSync(join(replyDir, `${t.id}.md`), "utf8")).toBe(`did ${t.id} with a deviation note`);
    }
  });

  test("reply artifacts encode task ids instead of using them as paths", async () => {
    const initial = fixture([]).repo;
    const maliciousId = `../../escape-${basename(initial)}`;
    const tasks = [task(initial, maliciousId)];
    const { repo, taskFile } = fixture(tasks);
    const replyDir = join(artifactDir(repo), "implement-replies");
    const escapedPath = join(replyDir, `${maliciousId}.md`);
    rmSync(replyDir, { recursive: true, force: true });
    rmSync(escapedPath, { force: true });

    await implement({ repo, taskFile, branch: "impl/reply-id-escape" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent(() => {
        writeFileSync(join(repo, `escape-${basename(initial)}.txt`), "after\n");
        return "safe reply";
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(readFileSync(join(replyDir, `${encodeURIComponent(maliciousId)}.md`), "utf8")).toBe("safe reply");
    expect(existsSync(escapedPath)).toBe(false);
  });

  test("reply artifacts persist the final repair reply", async () => {
    const initial = fixture([]).repo;
    const tasks = [task(initial, "a")];
    const { repo, taskFile } = fixture(tasks);
    const replyDir = join(artifactDir(repo), "implement-replies");
    rmSync(replyDir, { recursive: true, force: true });
    let buildCalls = 0;

    await implement({ repo, taskFile, branch: "impl/final-repair-reply" }, stubContext(repo,
      {
      evalGate: async (name) => name === "build" && ++buildCalls === 2 ? { ok: false, log: "red" } : { ok: true, log: "ok" },
      createAgent: () => new StubAgent((_call, prompt) => {
        if (prompt.includes("failed build/test")) {
          writeFileSync(join(repo, "a.txt"), "a after repair\n");
          return "final repair reply";
        }
        return "initial reply";
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(readFileSync(join(replyDir, "a.md"), "utf8")).toBe("final repair reply");
  });

  test("reply artifact write failures are issues and do not abort the run", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks);
    const replyDir = join(artifactDir(repo), "implement-replies");
    rmSync(replyDir, { recursive: true, force: true });
    mkdirSync(artifactDir(repo), { recursive: true });
    writeFileSync(replyDir, "not a directory");

    const result = await implement({ repo, taskFile, branch: "impl/reply-write-failure" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
        return "reply should have been persisted";
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.prBody).toContain("reply artifact write failed");
    expect(result.issues.join("\n")).toContain("reply artifact write failed");
  });

  test("relevant undeclared file changes are allowed", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks);

    const result = await implement({ repo, taskFile, branch: "impl/undeclared" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) {
          writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
          writeFileSync(join(repo, "rogue.txt"), "undeclared\n");
        }
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.prBody).not.toContain("changed undeclared files");
    expect(result.issues.join("\n")).not.toContain("changed undeclared files");
    expect(result.issues).toEqual([]);
  });

  test("undeclared spec files without a test eval are flagged as unverified", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks, { evals: { build: "build" } });

    const result = await implement({ repo, taskFile, branch: "impl/unverified-test" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) {
          writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
          writeFileSync(join(repo, "foo.spec.ts"), "test(\"x\", () => {});\n");
        }
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.issues.join("\n")).toContain("no test eval");
    expect(result.issues.join("\n")).toContain("foo.spec.ts");
  });

  test("declared-only file changes do not record scope issues", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks);

    const result = await implement({ repo, taskFile, branch: "impl/declared-only" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.issues.join("\n")).not.toContain("changed undeclared files");
    expect(result.issues.join("\n")).not.toContain("no test eval");
  });

  test("injects configured context into coder prompts", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks, {
      context: [{ path: "ARCHITECTURE.md", update: true }],
      contextFiles: { "ARCHITECTURE.md": "Architecture fact\n" },
    });
    let firstPrompt = "";

    const result = await implement({ repo, taskFile, branch: "impl/context-prompt" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        firstPrompt ||= prompt;
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.prBody).toContain("## Issues\n- none");
    expect(firstPrompt).toContain("ARCHITECTURE.md (update: true)");
    expect(firstPrompt).toContain("Architecture fact");
  });

  test("update-enabled context write-back is allowed outside declared task files", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks, {
      context: [{ path: "ARCHITECTURE.md", update: true }],
      contextFiles: { "ARCHITECTURE.md": "Old architecture\n" },
    });

    const result = await implement({ repo, taskFile, branch: "impl/context-writeback" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) {
          writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
          writeFileSync(join(repo, "ARCHITECTURE.md"), "Updated architecture\n");
        }
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.prBody).toContain("## Issues\n- none");
    expect(result.issues.join("\n")).not.toContain("changed undeclared files");
  });

  test("task dependencies beyond the declared file list are allowed", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks, {
      context: [{ path: "README.md", update: false }],
      contextFiles: { "README.md": "Read only\n" },
    });

    const result = await implement({ repo, taskFile, branch: "impl/context-readonly" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) {
          writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
          writeFileSync(join(repo, "README.md"), "Changed read-only context\n");
        }
      }),
      review: async () => ({ valid: true, findings: "", findingsFile: "", unresolvedHigh: 0, fixRan: false, issues: [] }),
    }));

    expect(result.prBody).not.toContain("changed undeclared files");
    expect(result.issues.join("\n")).not.toContain("changed undeclared files");
    expect(result.issues).toEqual([]);
  });

  test("review blocking propagates into the PR body", async () => {
    const base = fixture([]).repo;
    const tasks = [task(base, "a")];
    const { repo, taskFile } = fixture(tasks);
    const result = await implement({ repo, taskFile, branch: "impl/review-block" }, stubContext(repo,
      {
      evalGate: okEval,
      createAgent: () => new StubAgent((_call, prompt) => {
        const id = prompt.match(/## Your task: (\w+)/)?.[1];
        if (id) writeFileSync(join(repo, `${id}.txt`), `${id} after\n`);
      }),
      review: async () => ({ valid: true, findings: "HIGH a", findingsFile: "", unresolvedHigh: 1, fixRan: true, issues: ["high remains"] }),
    }));

    expect(result.reviewBlocking).toBe(true);
    expect(result.prBody).toContain("# BLOCKING");
    expect(result.prBody).toContain("review: high remains");
  });
});
