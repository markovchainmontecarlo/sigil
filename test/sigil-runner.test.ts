import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runTypeScriptSigil, SigilRunnerError, validateTypeScriptSigil } from "../src/sigil-runner.js";

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-runner-repo-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "gpt-5.5" } },
    evals: { build: "printf build-ok" },
    context: [],
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", batchSize: 1, repairLimit: 1, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  }, null, 2));
  return dir;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sigil-runner-"));
}

function writeWorkflow(dir: string, body: string): string {
  const file = join(dir, "workflow.ts");
  writeFileSync(file, body);
  return file;
}

describe("TypeScript sigil runner", () => {
  test("validates a default export without running the workflow body", async () => {
    const dir = tempDir();
    const marker = join(dir, "body-ran.txt");
    const workflowFile = writeWorkflow(dir, `
      import { writeFileSync } from "node:fs";
      import { sigil } from "sigil";

      export default sigil("valid-default", async () => {
        writeFileSync(${JSON.stringify(marker)}, "ran");
        return { ok: true };
      });
    `);

    const result = await validateTypeScriptSigil(workflowFile);

    expect(result).toEqual({ valid: true, errors: [] });
    expect(existsSync(marker)).toBe(false);
  });

  test("validates a named workflow export", async () => {
    const workflowFile = writeWorkflow(tempDir(), `
      import { sigil } from "sigil";

      export const workflow = sigil("valid-named", async () => ({ ok: true }));
    `);

    await expect(validateTypeScriptSigil(workflowFile)).resolves.toEqual({ valid: true, errors: [] });
  });

  test("validation reports missing workflow files", async () => {
    const result = await validateTypeScriptSigil(join(tempDir(), "missing.ts"));

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("workflow file not found");
  });

  test("validation reports import failures", async () => {
    const workflowFile = writeWorkflow(tempDir(), "throw new Error('top level failed');");

    const result = await validateTypeScriptSigil(workflowFile);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("workflow import failed");
  });

  test("validation reports missing callable exports", async () => {
    const workflowFile = writeWorkflow(tempDir(), "export const value = 1;");

    const result = await validateTypeScriptSigil(workflowFile);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing callable workflow export");
  });

  test("runs a default export from a temporary directory without local node_modules", async () => {
    const repo = tempRepo();
    const runDir = tempDir();
    const workflowFile = writeWorkflow(runDir, `
      import { sigil } from "sigil";

      export default sigil("default-workflow", async (ctx, input: { repo: string; value: string }) => {
        const gate = await ctx.evals("build");
        const child = sigil("child", async (_ctx, childInput: { repo: string; value: string }) => ({
          childValue: childInput.value,
        }));
        const nested = await ctx.run(child, { repo: input.repo, value: input.value });

        return {
          repo: input.repo,
          value: input.value,
          gate,
          nested,
          hasIssues: ctx.issues.length > 0,
        };
      });
    `);
    const inputFile = join(runDir, "input.json");
    writeFileSync(inputFile, JSON.stringify({ value: "from-input" }));

    const result = await runTypeScriptSigil({ repo, file: workflowFile, inputFile });
    const output = JSON.parse(result.formatted);

    expect(existsSync(join(runDir, "node_modules"))).toBe(false);
    expect(output.repo).toBe(repo);
    expect(output.value).toBe("from-input");
    expect(output.gate.ok).toBe(true);
    expect(output.gate.log).toBe("build-ok");
    expect(output.nested).toEqual({ childValue: "from-input" });
    expect(output.hasIssues).toBe(false);
  });

  test("runs a named workflow export", async () => {
    const repo = tempRepo();
    const workflowFile = writeWorkflow(tempDir(), `
      import { sigil } from "sigil";

      export const workflow = sigil("named-workflow", async (_ctx, input: { repo: string }) => ({
        repo: input.repo,
        kind: "named",
      }));
    `);

    const result = await runTypeScriptSigil({ repo, file: workflowFile });

    expect(JSON.parse(result.formatted)).toEqual({ repo, kind: "named" });
  });

  test("bundled workflows resolve feature-owned prompt resources from the package", async () => {
    const repo = tempRepo();
    const workflowFile = writeWorkflow(tempDir(), `
      import { planningPrompts, sigil } from "sigil";

      export default sigil("prompt-resource", async () => ({
        prompt: planningPrompts.investigate({
          INTENT: "inspect prompt portability",
          BRIEF: "",
          CONTEXT: "",
        }),
      }));
    `);

    const result = await runTypeScriptSigil({ repo, file: workflowFile });

    expect(JSON.parse(result.formatted).prompt).toContain("inspect prompt portability");
  });

  test("repo flag takes precedence over input JSON repo field", async () => {
    const repo = tempRepo();
    const dir = tempDir();
    const workflowFile = writeWorkflow(dir, `
      import { sigil } from "sigil";

      export default sigil("repo-precedence", async (_ctx, input: { repo: string; label: string }) => input);
    `);
    const inputFile = join(dir, "input.json");
    writeFileSync(inputFile, JSON.stringify({ repo: "/wrong/repo", label: "kept" }));

    const result = await runTypeScriptSigil({ repo, file: workflowFile, inputFile });

    expect(JSON.parse(result.formatted)).toEqual({ repo, label: "kept" });
  });

  test("writes formatted result JSON to the output file", async () => {
    const repo = tempRepo();
    const dir = tempDir();
    const outFile = join(dir, "nested", "result.json");
    const workflowFile = writeWorkflow(dir, `
      import { sigil } from "sigil";

      export default sigil("write-result", async () => ({ ok: true }));
    `);

    const result = await runTypeScriptSigil({ repo, file: workflowFile, outFile });

    expect(result.formatted).toBe("{\n  \"ok\": true\n}\n");
    expect(readFileSync(outFile, "utf8")).toBe(result.formatted);
  });

  test("uses run directory artifacts when runDir is supplied", async () => {
    const repo = tempRepo();
    const runDir = tempDir();
    const workflowFile = writeWorkflow(runDir, `
      import { sigil } from "sigil";

      export default sigil("artifact-root", async (ctx) => {
        const artifact = await ctx.artifacts.write("reports/out.md", "artifact body\\n");
        return { artifact, artifactDir: ctx.artifacts.dir };
      });
    `);

    const result = await runTypeScriptSigil({ repo, file: workflowFile, runDir });
    const output = JSON.parse(result.formatted);

    expect(output.artifactDir).toBe(join(runDir, "artifacts"));
    expect(output.artifact).toBe(join(runDir, "artifacts", "reports", "out.md"));
    expect(readFileSync(output.artifact, "utf8")).toBe("artifact body\n");
  });

  test("creates an isolated local artifact directory when runDir is omitted", async () => {
    const repo = tempRepo();
    const workflowFile = writeWorkflow(tempDir(), `
      import { sigil } from "sigil";

      export default sigil("default-artifact-root", async (ctx) => ({
        artifactDir: ctx.artifacts.dir,
      }));
    `);

    const result = await runTypeScriptSigil({ repo, file: workflowFile });

    const output = JSON.parse(result.formatted);
    expect(output.artifactDir.startsWith(join(repo, ".sigil", "runs"))).toBe(true);
  });

  test("fails clearly when the workflow file is missing", async () => {
    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: join(tempDir(), "missing.ts"),
    })).rejects.toMatchObject({
      code: "missing-file",
      message: expect.stringContaining("workflow file not found"),
    });
  });

  test("fails clearly when input JSON is invalid", async () => {
    const dir = tempDir();
    const inputFile = join(dir, "input.json");
    const workflowFile = writeWorkflow(dir, "export default async () => ({ ok: true });");
    writeFileSync(inputFile, "{not json");

    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: workflowFile,
      inputFile,
    })).rejects.toMatchObject({
      code: "invalid-input-json",
      message: expect.stringContaining("invalid input JSON"),
    });
  });

  test("fails clearly when no callable export exists", async () => {
    const workflowFile = writeWorkflow(tempDir(), "export const value = 1;");

    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: workflowFile,
    })).rejects.toMatchObject({
      code: "missing-export",
      message: expect.stringContaining("missing callable workflow export"),
    });
  });

  test("fails clearly when importing the workflow throws", async () => {
    const workflowFile = writeWorkflow(tempDir(), "throw new Error('top level failed');");

    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: workflowFile,
    })).rejects.toMatchObject({
      code: "import-failure",
      message: expect.stringContaining("workflow import failed"),
    });
  });

  test("fails clearly when the workflow throws", async () => {
    const workflowFile = writeWorkflow(tempDir(), `
      export default async () => {
        throw new Error("workflow exploded");
      };
    `);

    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: workflowFile,
    })).rejects.toMatchObject({
      code: "workflow-exception",
      message: expect.stringContaining("workflow failed: workflow exploded"),
    });
  });

  test("runner errors are instances of SigilRunnerError", async () => {
    await expect(runTypeScriptSigil({
      repo: tempRepo(),
      file: join(tempDir(), "missing.ts"),
    })).rejects.toBeInstanceOf(SigilRunnerError);
  });
});
