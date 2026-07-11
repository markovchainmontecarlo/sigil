import { describe, expect, test } from "bun:test";
import { BACKLOG_CONTRACT_VERSION, checkBacklog, orderItems, validateBacklog, type Backlog, type WorkItem } from "../src/contracts/backlog.js";

const item = (id: string, dependsOn: string[] = []): WorkItem => ({
  id,
  goal: `Goal ${id}`,
  dependsOn,
  brief: `Brief ${id}`,
});
const backlog = (items: WorkItem[]): Backlog => ({ contractVersion: BACKLOG_CONTRACT_VERSION, mission: "fixture", items });

describe("backlog contract", () => {
  test("valid backlog has no errors and validates", () => {
    const valid = backlog([item("a"), item("b", ["a"])]);

    expect(checkBacklog(valid).errors).toEqual([]);
    expect(validateBacklog(valid).items.map((workItem) => workItem.id)).toEqual(["a", "b"]);
  });

  test("invalid backlog collects empty items", () => {
    const result = checkBacklog(backlog([]));

    expect(result.backlog).toBeNull();
    expect(result.errors).toContain("backlog has no items");
  });

  test("invalid backlog collects duplicate ids, non-kebab ids, empty brief, unknown dependencies, and cycles", () => {
    const invalid = backlog([
      { ...item("bad_id"), brief: "" },
      item("dup"),
      item("dup"),
      item("cycle-a", ["cycle-b", "missing"]),
      item("cycle-b", ["cycle-a"]),
    ]);

    const errors = checkBacklog(invalid).errors.join("\n");

    expect(errors).toContain("id must be kebab-case");
    expect(errors).toContain("duplicate work item id: dup");
    expect(errors).toContain("missing brief");
    expect(errors).toContain("depends on unknown item: missing");
    expect(errors).toContain("dependency cycle through work item");
  });

  test("orderItems returns every item once after all dependencies", () => {
    const valid = backlog([
      item("a"),
      item("b"),
      item("c", ["a"]),
      item("d", ["b"]),
      item("e", ["c", "d"]),
    ]);

    const order = orderItems(valid);
    const ids = order.map((workItem) => workItem.id);

    expect(new Set(ids).size).toBe(valid.items.length);
    expect(ids).toHaveLength(valid.items.length);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("e"));
    expect(ids.indexOf("d")).toBeLessThan(ids.indexOf("e"));
  });

  test("orderItems throws on dependency cycles", () => {
    expect(() => orderItems(backlog([item("a", ["b"]), item("b", ["a"])]))).toThrow("cycle in backlog");
  });
});
