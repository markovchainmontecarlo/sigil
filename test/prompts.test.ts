import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { breakdownPrompts, implementationPrompts, planningPrompts } from "../src/index.js";
import { interpolate } from "../src/prompts.js";

describe("prompts", () => {
  test("renders a grouped template and interpolates supplied vars", () => {
    const rendered = planningPrompts.investigate({ INTENT: "ship it", BRIEF: "", CONTEXT: "loaded context" });
    expect(rendered).toContain("ship it");
    expect(rendered).toContain("loaded context");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });


  test("root export exposes supported feature-owned prompt groups", async () => {
    const api = await import("../src/index.js");

    expect("prompts" in api).toBe(false);
    expect(api.planningPrompts.investigate).toBeFunction();
    expect(api.implementationPrompts.task).toBeFunction();
    expect(api.reviewPrompts.findings).toBeFunction();
    expect(api.breakdownPrompts.cut).toBeFunction();
    expect("taskGraphPrompts" in api).toBe(false);
  });

  test("prompt utilities do not expose the removed root prompt registry", async () => {
    const api = await import("../src/prompts.js");

    expect("PROMPT_ROOT" in api).toBe(false);
    expect("prompts" in api).toBe(false);
    expect(api.createPromptGroup).toBeFunction();
    expect(api.interpolate).toBeFunction();
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.files).not.toContain("prompts");
  });
  test("feature workflows own their JSON repair prompts", () => {
    const backlogRepair = breakdownPrompts.fixJson({
      FILE: "/tmp/backlog.json",
      CONTRACT: "backlog contract",
      ERRORS: "bad backlog",
    });
    const taskGraphRepair = planningPrompts.fixJson({
      FILE: "/tmp/task-graph.json",
      CONTRACT: "task graph contract",
      ERRORS: "bad task graph",
    });

    expect(backlogRepair).toContain("/tmp/backlog.json");
    expect(backlogRepair).toContain("bad backlog");
    expect(backlogRepair).toContain("backlog contract");
    expect(taskGraphRepair).toContain("/tmp/task-graph.json");
    expect(taskGraphRepair).toContain("bad task graph");
    expect(taskGraphRepair).toContain("task graph contract");
    expect(`${backlogRepair}
${taskGraphRepair}`).not.toMatch(/\{\{\w+\}\}/);
  });

  test("implement task prompt includes generalized configured write-back rule", () => {
    const rendered = implementationPrompts.task({
      PREAMBLE: "preamble",
      TASK_ID: "a",
      TASK_TITLE: "Task A",
      TASK_SUMMARY: "summary",
      DIAGRAMS: "",
      HANDOFF: "",
      CONTEXT: "context block",
      ACCEPTANCE: "- works",
      FILES: "- modify /tmp/a.txt",
    });

    expect(rendered).toContain("context block");
    expect(rendered).toContain("configured context file is marked `update: true`");
    expect(rendered).toContain("Files marked `update: false` are read-only context");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });


  test("leaves an unsupplied placeholder visible", () => {
    expect(interpolate("a {{X}} b", {})).toBe("a {{X}} b");
  });

  test("throws for a missing prompt file", () => {
    expect(() => planningPrompts.doesNotExist()).toThrow("prompt not found: doesNotExist");
  });

  test("rejects a path-traversal segment", () => {
    expect(() => planningPrompts[".."]()).toThrow("invalid prompt path");
  });
});
