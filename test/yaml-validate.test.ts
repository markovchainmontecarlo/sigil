import { describe, expect, test } from "bun:test";

import { validateYamlWorkflow } from "../src/yaml/validate.js";

const baseWorkflow = {
  name: "triage",
  stages: [
    {
      id: "understand",
      jobs: [
        {
          id: "analysis",
          agent: { provider: "codex", model: "gpt-5.5" },
          steps: [
            { id: "classify", prompt: "Reply BUG or FEATURE.", output: { enum: ["BUG", "FEATURE"] } },
            { id: "write-repro", prompt: "Write repro.", writes: "repro.sh", minBytes: 1 },
          ],
        },
      ],
    },
    {
      id: "act",
      jobs: [
        {
          id: "fix",
          agent: { provider: "codex", model: "gpt-5.5" },
          condition: "$analysis.classify.output == 'BUG'",
          steps: [
            { id: "implement", prompt: "Use $artifacts/repro.sh" },
            { id: "gate", eval: "build" },
          ],
        },
      ],
    },
  ],
};

describe("yaml validate", () => {
  test("accepts a valid static workflow", () => {
    const result = validateYamlWorkflow(baseWorkflow);
    expect(result.errors).toEqual([]);
    expect(result.workflow?.name).toBe("triage");
  });


  test("accepts the unified software-change built-in workflow", () => {
    const result = validateYamlWorkflow({
      name: "software-change-demo",
      stages: [{
        id: "change",
        steps: [{
          id: "run",
          run: { workflow: "software-change", input: { intent: "Ship the change." } },
        }],
      }],
    });

    expect(result.errors).toEqual([]);
  });

  test("rejects prompt steps in deterministic jobs", () => {
    const result = validateYamlWorkflow({
      name: "bad",
      stages: [{ id: "stage", jobs: [{ id: "job", steps: [{ id: "prompt", prompt: "hi" }] }] }],
    });
    expect(result.errors.join("\n")).toContain("prompt steps require an agent job");
  });

  test("rejects script steps in agent jobs", () => {
    const result = validateYamlWorkflow({
      name: "bad",
      stages: [{ id: "stage", jobs: [{ id: "job", agent: { provider: "codex", model: "gpt-5.5" }, steps: [{ id: "script", script: "echo hi" }] }] }],
    });
    expect(result.errors.join("\n")).toContain("agent jobs cannot contain script or sh steps");
  });

  test("rejects unresolved references", () => {
    const result = validateYamlWorkflow({
      name: "bad",
      stages: [{ id: "stage", jobs: [{ id: "job", agent: { provider: "codex", model: "gpt-5.5" }, steps: [{ id: "prompt", prompt: "Use $missing.step.output" }] }] }],
    });
    expect(result.errors.join("\n")).toContain("unknown output reference");
  });
});
