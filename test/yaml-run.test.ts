import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { createContext, type SigilContext } from "../src/context.js";
import { runYamlWorkflowFile } from "../src/yaml/run.js";
import type { SigilAgent } from "../src/agents.js";

class FakeAgent implements SigilAgent {
  constructor(private readonly name: string) {}
  async prompt(text: string): Promise<string> {
    if (text.includes("Reply BUG or FEATURE")) return "BUG";
    if (text.includes("Write repro")) {
      const match = text.match(/- repro\.sh: (.+)$/m);
      if (match?.[1]) writeFileSync(match[1], "#!/bin/sh\necho repro\n");
      return "#!/bin/sh\necho repro\n";
    }
    return `${this.name}: ${text.split("\n")[0]}`;
  }
  async close() {}
  async [Symbol.asyncDispose]() {}
}

function fakeContext(repo: string): SigilContext {
  const base = createContext(repo);
  return {
    ...base,
    agent(binding) {
      const name = typeof binding === "string" ? binding : `${binding.provider}:${binding.model}`;
      return new FakeAgent(name) as unknown as ReturnType<typeof base.agent>;
    },
    async evals(name: string) {
      return { ok: true, log: `${name} ok` };
    },
  };
}

describe("yaml run", () => {
  test("runs a deterministic-only workflow file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-yaml-run-"));
    const workflowFile = join(repo, "workflow.yaml");
    writeFileSync(workflowFile, [
      "name: deterministic-demo",
      "stages:",
      "  - id: report",
      "    jobs:",
      "      - id: render",
      "        steps:",
      "          - id: hello",
      "            script: echo hello",
    ].join("\n"));

    const result = await runYamlWorkflowFile(workflowFile, repo);
    expect(result.workflow).toBe("deterministic-demo");
    expect(result.stageResults[0]?.jobResults[0]?.stepResults[0]?.output).toBe("hello");
  });

  test("runs an agent workflow file with prompt, writes, eval, and condition", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-yaml-run-"));
    mkdirSync(join(repo, ".git"));
    const workflowFile = join(repo, "workflow.yaml");
    writeFileSync(workflowFile, [
      "name: triage-demo",
      "stages:",
      "  - id: understand",
      "    jobs:",
      "      - id: analysis",
      "        agent:",
      "          provider: codex",
      "          model: gpt-5.5",
      "        steps:",
      "          - id: classify",
      "            prompt: Reply BUG or FEATURE",
      "            output:",
      "              enum: [BUG, FEATURE]",
      "          - id: write-repro",
      "            prompt: Write repro",
      "            writes: repro.sh",
      "            minBytes: 1",
      "  - id: act",
      "    jobs:",
      "      - id: fix",
      "        agent:",
      "          provider: codex",
      "          model: gpt-5.5",
      "        condition: $analysis.classify.output == 'BUG'",
      "        steps:",
      "          - id: implement",
      "            prompt: Use $artifacts/repro.sh",
      "          - id: gate",
      "            eval: build",
    ].join("\n"));

    const result = await runYamlWorkflowFile(workflowFile, repo, fakeContext(repo));
    expect(result.workflow).toBe("triage-demo");
    expect(result.artifacts["repro.sh"]).toBeTruthy();
    expect(result.stageResults).toHaveLength(2);
  });
});
