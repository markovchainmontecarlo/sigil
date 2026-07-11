import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, checkTaskGraph, planBatches, validateTaskGraph, type Task, type TaskGraph } from "../src/contracts/task-graph.js";

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

  test("invalid graph collects missing ids, missing repo root for relative paths, unknown dependencies, and cycles", () => {
    const invalid = graph([
      { ...task(""), files: [file("relative.ts")] },
      task("a", ["b", "missing"]),
      task("b", ["a"]),
    ]);

    const errors = checkTaskGraph(invalid).errors.join("\n");

    expect(errors).toContain("task missing id");
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
    expect(absolutePathErrors).toContain("/Users/x/repo");
    expect(() => validateTaskGraph(absolutePathProject)).toThrow("project");
    expect(checkTaskGraph(emptyProject).errors.join("\n")).toContain("project");
    expect(checkTaskGraph(slugProject).errors.filter((error) => error.includes("project"))).toEqual([]);
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

  test("planBatches respects dependency order and task-count cap", () => {
    const tasks = [task("a"), task("b"), task("c", ["a"]), task("d", ["b"]), task("e", ["c", "d"])];
    const { batches, byId } = planBatches(tasks, 2);
    const order = batches.flat();

    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("e"));
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("e"));
    expect(byId.e.id).toBe("e");
  });

  test("planBatches throws on dependency cycles", () => {
    expect(() => planBatches([task("a", ["b"]), task("b", ["a"])], 2)).toThrow("cycle in task graph");
  });
});
