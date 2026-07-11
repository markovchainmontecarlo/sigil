import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";
import type { z } from "zod";

async function workflowSchemas(): Promise<{
  input: z.ZodType;
  output: z.ZodType;
}> {
  const { swe } = await import("../src/mastra.js");
  return {
    input: swe.inputSchema as z.ZodType,
    output: swe.outputSchema as z.ZodType,
  };
}

describe("Mastra software-change adapter", () => {
  test("creates the default file-backed storage directory on import", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sigil-mastra-import-"));
    const modulePath = join(process.cwd(), "src/mastra.ts");
    const script = [
      `await import(${JSON.stringify(modulePath)});`,
      "const { existsSync } = await import('node:fs');",
      "const { join } = await import('node:path');",
      "if (!existsSync(join(process.cwd(), '.mastra'))) throw new Error('missing .mastra directory');",
      "if (!existsSync(join(process.cwd(), '.mastra', 'sigil.db'))) throw new Error('missing sigil.db');",
    ].join("\n");

    execFileSync(process.execPath, ["--eval", script], {
      cwd,
      encoding: "utf8",
    });

    expect(existsSync(join(cwd, ".mastra", "sigil.db"))).toBe(true);
  });

  test("accepts both task graph entry mode and delivery-base selection", async () => {
    const schemas = await workflowSchemas();
    const input = {
      intent: "Apply the ready graph.",
      repo: "/tmp/repo",
      taskFile: "/tmp/task-graph.json",
      baseBranch: "feature/integration",
    };

    expect(schemas.input.parse(input)).toEqual(input);
  });

  test("preserves the complete software-change evidence contract", async () => {
    const schemas = await workflowSchemas();
    const plan = {
      taskFile: "/tmp/task-graph.json",
      taskCount: 1,
      valid: true,
      issues: [],
    };
    const implementation = {
      branch: "sigil/change",
      prBody: "## Issues\n- none\n",
      reviewBlocking: false,
      issues: [],
      failedTasks: [],
      noopTasks: [],
    };
    const result = {
      stage: "implementation",
      taskFile: plan.taskFile,
      taskCount: plan.taskCount,
      valid: true,
      plan,
      implementation,
      branch: implementation.branch,
      prBody: implementation.prBody,
      reviewBlocking: false,
      issues: [],
      failedTasks: [],
      noopTasks: [],
    };

    expect(schemas.output.parse(result)).toEqual(result);
  });
});
