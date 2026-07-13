import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, checkTaskGraph, validateTaskGraph, type Task, type TaskGraph } from "../src/contracts/task-graph.js";

const file = (path = "/repo/src/file.ts") => ({ path, action: "modify" as const, details: ["update file"] });
const task = (id: string, dependencies: string[] = []): Task => ({
  id,
  title: `Task ${id}`,
  summary: `Summary ${id}`,
  dependencies,
  acceptanceCriteria: ["works"],
  diagrams: [],
  files: [file(`/repo/src/${id}.ts`)],
});
const graph = (tasks: Task[]): TaskGraph => ({ contractVersion: CONTRACT_VERSION, project: "fixture", tasks });

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

  test("assistant-authored graphs normalize optional arrays and validate goal and unknown fields", () => {
    const minimal = {
      contractVersion: CONTRACT_VERSION,
      project: "assistant-change",
      goal: "Ship the accepted behavior.",
      tasks: [{
        id: "change",
        title: "Make the change",
        summary: "Implement the accepted outcome.",
        acceptanceCriteria: ["The accepted behavior is observable."],
        files: [{ path: "src/change.ts", action: "modify", details: ["Implement the behavior."] }],
      }],
    };

    const normalized = validateTaskGraph(minimal, { repoRoot: "/repo" });
    expect(normalized.tasks[0].dependencies).toEqual([]);
    expect(normalized.tasks[0].diagrams).toEqual([]);
    expect(checkTaskGraph({ ...minimal, goal: 42 }, { repoRoot: "/repo" }).errors.join("\n")).toContain("goal");
    expect(checkTaskGraph({ ...minimal, typo: true }, { repoRoot: "/repo" }).errors.join("\n")).toContain("Unrecognized key");
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
