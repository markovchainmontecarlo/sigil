import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { breakdownPrompts, implementationPrompts, planningPrompts } from "../src/index.js";
import { interpolate } from "../src/prompts.js";

describe("prompts", () => {
  test("renders a grouped template and interpolates supplied vars", () => {
    const rendered = planningPrompts.investigate({ INTENT: "ship it", BRIEF: "", CONTEXT: "loaded context", RUBRIC: "planning rubric" });
    expect(rendered).toContain("ship it");
    expect(rendered).toContain("loaded context");
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });

  test("planning rubrics divide independent authoring from synthesis", () => {
    const planner = planningPrompts.plannerRubric();
    const synthesis = planningPrompts.synthesisRubric();

    for (const phrase of ["cohesive change", "file responsibility", "produced", "consumed", "acceptance", "verification", "placeholder", "self-review"]) {
      expect(planner.toLowerCase()).toContain(phrase);
    }
    for (const phrase of ["supported unique", "requirements crosswalk", "task boundaries", "interface ownership", "verification conflicts", "hidden conversation context"]) {
      expect(synthesis.toLowerCase()).toContain(phrase);
    }
    expect(`${planner}\n${synthesis}`).not.toMatch(/superpowers|subagent|\.codex|execution handoff/i);
  });

  test("planning stages request complete, repository-grounded plan evidence", () => {
    const investigate = planningPrompts.investigate({ INTENT: "goal", BRIEF: "brief", CONTEXT: "context", RUBRIC: "rubric" });
    const writePlan = planningPrompts.writePlan({ OUT_FILE: "/tmp/plan.md", RUBRIC: "rubric" });
    const compare = planningPrompts.comparePlans({ INTENT: "goal", PLANS: "plans", CONVERGE_FILE: "convergence", DIVERGE_FILE: "divergence", CROSSWALK_FILE: "crosswalk", RUBRIC: "rubric" });

    expect(investigate).toMatch(/scope|ownership|state flow|callers|tests|configuration|verified|falsified|unresolved/i);
    expect(investigate).toMatch(/confirmed development handoff/i);
    expect(investigate).toMatch(/preserve.*intent.*acceptance criteria.*decisions.*architecture.*constraints.*non-goals/is);
    expect(investigate).toMatch(/repository.*claims.*hypotheses.*verified/is);
    expect(investigate).not.toMatch(/brief contains non-authoritative leads/i);
    expect(writePlan).toMatch(/architecture|constraints|non-goals|produced|consumed|verification|self-review/i);
    expect(compare).toMatch(/requirements crosswalk|task boundaries|interfaces|verification|omission/i);
    expect(`${investigate}\n${writePlan}\n${compare}`).not.toMatch(/\{\{\w+\}\}/);
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

  test("implementation prompts separate session context and task data", () => {
    const session = implementationPrompts.sessionContext({
      PREAMBLE: "preamble",
      GOAL: "goal",
      ARCHITECTURE: "architecture",
      CONSTRAINTS: "- none",
      NON_GOALS: "- none",
      CONFIRMED_BRIEF: "Confirmed outcome and boundaries",
      HANDOFF: "handoff",
      CONTEXT: "context block",
    });
    const instructions = implementationPrompts.taskInstructions();
    const task = implementationPrompts.task({
      TASK_ID: "a",
      TASK_TITLE: "Task A",
      TASK_SUMMARY: "summary",
      DEPENDENCIES: "- none",
      DIAGRAMS: "",
      ACCEPTANCE: "- works",
      INTERFACES: "Produces:\n- output: behavior\nConsumes:\n- none",
      VERIFICATION: "- command: bun test\n  expected: pass",
      FILES: "- modify /tmp/a.txt",
    });

    expect(session).toContain("context block");
    expect(session).toContain("## Confirmed brief");
    expect(session).toContain("Confirmed outcome and boundaries");
    expect(session).toMatch(/intent.*acceptance criteria.*decisions.*architecture.*constraints.*non-goals/is);
    expect(session).toMatch(/verify repository descriptions.*claims/is);
    expect(instructions).toContain("configured `update: true` context files");
    expect(instructions).toContain("Treat `update: false` context as read-only");
    expect(task).not.toContain("context block");
    expect(`${session}\n${instructions}\n${task}`).not.toMatch(/\{\{\w+\}\}/);
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
