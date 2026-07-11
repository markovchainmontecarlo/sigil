import { describe, expect, test } from "bun:test";

import { compileYamlWorkflow } from "../src/yaml/compile.js";
import type { YamlWorkflow } from "../src/yaml/types.js";

const workflow: YamlWorkflow = {
  name: "triage",
  stages: [
    {
      id: "understand",
      jobs: [
        {
          id: "analysis",
          agent: { provider: "codex", model: "gpt-5.5" },
          steps: [
            { id: "summary", prompt: "Summarize." },
            { id: "classify", prompt: "Classify." },
          ],
        },
        {
          id: "report",
          steps: [{ id: "render", script: "echo done" }],
        },
      ],
    },
  ],
};

describe("yaml compile", () => {
  test("preserves agent and deterministic job boundaries", () => {
    const compiled = compileYamlWorkflow(workflow, process.cwd());
    expect(compiled.stages).toHaveLength(1);
    expect(compiled.stages[0]?.jobs[0]?.kind).toBe("agent-job");
    expect(compiled.stages[0]?.jobs[1]?.kind).toBe("deterministic-job");
  });
});
