import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, checkTaskGraph, validateTaskGraph, type Task, type TaskGraph } from "../src/contracts/task-graph.js";

const file = (path = "/repo/src/file.ts") => ({ path, action: "modify" as const, details: ["update file"] });
const task = (id: string, dependencies: string[] = []): Task => ({
  id,
  title: `Task ${id}`,
  summary: `Summary ${id}`,
  dependencies,
  interfaces: {
    produces: [{ name: `${id}-result`, description: `${id} behavior is available` }],
    consumes: dependencies.map((taskId) => ({ taskId, name: `${taskId}-result`, description: `uses ${taskId}` })),
  },
  acceptanceCriteria: ["works"],
  verification: [{ kind: "command", command: "bun test", expected: "tests pass" }],
  diagrams: [],
  files: [file(`/repo/src/${id}.ts`)],
});
const graph = (tasks: Task[]): TaskGraph => ({
  contractVersion: CONTRACT_VERSION,
  project: "fixture",
  goal: "Deliver the fixture behavior",
  architecture: "Each task exposes an explicit result to its dependents.",
  constraints: [],
  nonGoals: [],
  tasks,
});

describe("task graph contract", () => {
  test("valid graph has no errors and validates", () => {
    const valid = graph([task("a"), task("b", ["a"])]);

    expect(checkTaskGraph(valid).errors).toEqual([]);
    expect(validateTaskGraph(valid).tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("structural validation reports the exact invalid field", () => {
    const invalid = graph([{ ...task(""), files: [file("relative.ts")] }]);

    expect(checkTaskGraph(invalid).errors.join("\n")).toContain("tasks.0.id");
  });

  test("semantic validation collects path, dependency, and cycle errors", () => {
    const invalid = graph([
      { ...task("root"), files: [file("relative.ts")] },
      task("a", ["b", "missing"]),
      task("b", ["a"]),
    ]);

    const errors = checkTaskGraph(invalid).errors.join("\n");

    expect(errors).toContain("file path is relative but no repo root was provided");
    expect(errors).toContain("depends on unknown task: missing");
    expect(errors).toContain("dependency cycle through task");
  });

  test("project must be a short kebab-case slug", () => {
    const absolutePathProject = { ...graph([task("a")]), project: "/Users/x/repo" };
    const emptyProject = { ...graph([task("a")]), project: "" };
    const slugProject = { ...graph([task("a")]), project: "rerun-idempotency" };

    const absolutePathErrors = checkTaskGraph(absolutePathProject).errors.join("\n");

    expect(absolutePathErrors).toContain("project");
    expect(() => validateTaskGraph(absolutePathProject)).toThrow("project");
    expect(checkTaskGraph(emptyProject).errors.join("\n")).toContain("project");
    expect(checkTaskGraph(slugProject).errors.filter((error) => error.includes("project"))).toEqual([]);
  });

  test("assistant-authored graphs require complete planning context and reject unknown fields", () => {
    const minimal = {
      contractVersion: CONTRACT_VERSION,
      project: "assistant-change",
      goal: "Ship the accepted behavior.",
      architecture: "The existing owner exposes the behavior through one public boundary.",
      constraints: [],
      nonGoals: [],
      tasks: [{
        id: "change",
        title: "Make the change",
        summary: "Implement the accepted outcome.",
        dependencies: [],
        interfaces: { produces: [], consumes: [] },
        acceptanceCriteria: ["The accepted behavior is observable."],
        verification: [{ kind: "manual", procedure: "Exercise the behavior", expected: "The outcome is visible", rationale: "The interaction requires visual judgment" }],
        diagrams: [],
        files: [{ path: "src/change.ts", action: "modify", details: ["Implement the behavior."] }],
      }],
    };

    const normalized = validateTaskGraph(minimal, { repoRoot: "/repo" });
    expect(normalized.tasks[0].dependencies).toEqual([]);
    expect(normalized.tasks[0].diagrams).toEqual([]);
    expect(checkTaskGraph({ ...minimal, architecture: undefined }, { repoRoot: "/repo" }).errors.join("\n")).toContain("architecture");
    expect(checkTaskGraph({ ...minimal, typo: true }, { repoRoot: "/repo" }).errors.join("\n")).toContain("Unrecognized key");
  });

  test("interfaces explain every dependency and reference produced outputs", () => {
    const missingConsumption = graph([task("a"), { ...task("b", ["a"]), interfaces: { produces: [], consumes: [] } }]);
    const unknownOutput = graph([task("a"), {
      ...task("b", ["a"]),
      interfaces: { produces: [], consumes: [{ taskId: "a", name: "missing", description: "uses it" }] },
    }]);
    const undeclaredDependency = graph([task("a"), {
      ...task("b"),
      interfaces: { produces: [], consumes: [{ taskId: "a", name: "a-result", description: "uses it" }] },
    }]);

    expect(checkTaskGraph(missingConsumption).errors.join("\n")).toContain("dependency a has no consumed interface");
    expect(checkTaskGraph(unknownOutput).errors.join("\n")).toContain("unknown interface a.missing");
    expect(checkTaskGraph(undeclaredDependency).errors.join("\n")).toContain("consumes from undeclared dependency a");
  });

  test("produced interface names are unique within a task", () => {
    const duplicate = task("a");
    duplicate.interfaces.produces.push({ name: "a-result", description: "duplicate" });

    expect(checkTaskGraph(graph([duplicate])).errors.join("\n")).toContain("duplicate produced interface: a-result");
  });

  test("repoRoot option resolves relative paths and rejects paths outside the repo", () => {
    const repoRoot = "/repo";
    const outsidePath = "/outside/file.ts";
    const insidePath = "/repo/src/file.ts";
    const relativePath = "src/file.ts";
    const outsideGraph = graph([{ ...task("a"), files: [file(outsidePath)] }]);
    const insideGraph = graph([{ ...task("a"), files: [file(insidePath)] }]);
    const relativeGraph = graph([{ ...task("a"), files: [file(relativePath)] }]);

    const outsideErrors = checkTaskGraph(outsideGraph, { repoRoot }).errors.join("\n");
    expect(outsideErrors).toContain("file path escapes repo root");
    expect(outsideErrors).toContain(outsidePath);

    const noRootErrors = checkTaskGraph(outsideGraph).errors.join("\n");
    expect(noRootErrors).not.toContain("file path escapes repo root");
    expect(() => validateTaskGraph(outsideGraph)).not.toThrow();

    expect(checkTaskGraph(insideGraph, { repoRoot }).errors).toEqual([]);
    expect(validateTaskGraph(relativeGraph, { repoRoot }).tasks[0].files[0].path).toBe(insidePath);
    expect(() => validateTaskGraph(outsideGraph, { repoRoot })).toThrow(/file path escapes repo root: \/outside\/file\.ts/);
  });


});
