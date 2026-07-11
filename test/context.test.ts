import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import type { SigilAgent } from "../src/agents.js";
import { createContext, loadConfiguredContext, renderContextBlock, sigil, type SigilContext } from "../src/context.js";
import { artifactDir } from "../src/paths.js";

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-context-test-"));
  writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
    agents: { coder: { provider: "codex", model: "gpt-5.5" }, reviewer: { provider: "codex", model: "gpt-5.5" } },
    evals: {},
    context: [],
    plan: { planners: ["coder"], synthesizer: "reviewer" },
    implement: { coder: "coder", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
    review: { reviewer: "reviewer" },
  }, null, 2));
  return dir;
}

describe("createContext", () => {
  test("issues accumulate", () => {
    const ctx = createContext(tempRepo());

    ctx.issue("first");
    ctx.issue("second");

    expect(ctx.issues).toEqual(["first", "second"]);
  });

  test("artifacts.path stays inside artifactDir(repo)", () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const path = ctx.artifacts.path("task-graph.json");
    const rel = relative(artifactDir(repo), path);

    expect(ctx.artifacts.dir).toBe(artifactDir(repo));
    expect(rel).not.toStartWith("..");
    expect(rel).not.toBe("");
  });

  test("artifact root override controls artifact dir", () => {
    const repo = tempRepo();
    const artifactRoot = join(repo, ".sigil-run", "artifacts");
    const ctx = createContext(repo, { artifactRoot });

    expect(ctx.artifacts.dir).toBe(resolve(artifactRoot));
    expect(ctx.artifacts.path("out.md")).toBe(join(resolve(artifactRoot), "out.md"));
  });

  test("artifacts write creates parent directories and read returns contents", async () => {
    const ctx = createContext(tempRepo());

    const file = await ctx.artifacts.write("nested/answer.md", "artifact contents\n");
    const contents = await ctx.artifacts.read("nested/answer.md");

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("artifact contents\n");
    expect(contents).toBe("artifact contents\n");
  });

  test("artifact helpers reject path escapes", async () => {
    const ctx = createContext(tempRepo());

    expect(() => ctx.artifacts.path("../escape.md")).toThrow("escapes artifact dir");
    await expect(ctx.artifacts.write("../escape.md", "nope")).rejects.toThrow("escapes artifact dir");
    await expect(ctx.artifacts.read("../escape.md")).rejects.toThrow("escapes artifact dir");
  });

  test("sh runs shell strings in the repo and returns structured success", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "probe.txt"), "repo file\n");
    const ctx = createContext(repo);

    const result = await ctx.sh("pwd; cat probe.txt");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(repo);
    expect(result.stdout).toContain("repo file");
    expect(result.stderr).toBe("");
  });

  test("sh runs argv commands and returns nonzero exits without throwing", async () => {
    const ctx = createContext(tempRepo());

    const result = await ctx.sh({
      command: "node",
      args: ["-e", "console.error('bad'); process.exit(7)"],
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("bad");
    expect(result.message).toContain("exit code 7");
  });

  test("parallel invokes jobs and preserves Promise.all result order", async () => {
    const ctx = createContext(tempRepo());

    const result = await ctx.parallel([
      async () => new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5)),
      async () => "fast",
    ]);

    expect(result).toEqual(["slow", "fast"]);
  });

  test("parallelSettled returns all successful job values", async () => {
    const ctx = createContext(tempRepo());

    const result = await ctx.parallelSettled([
      async () => "first",
      async () => "second",
    ]);

    expect(result).toEqual([
      { ok: true, index: 0, value: "first" },
      { ok: true, index: 1, value: "second" },
    ]);
    expect(ctx.issues).toEqual([]);
  });

  test("parallelSettled records failed jobs and preserves successful branches", async () => {
    const ctx = createContext(tempRepo());

    const result = await ctx.parallelSettled([
      async () => "ok",
      async () => {
        throw new Error("branch failed");
      },
    ]);

    expect(result[0]).toEqual({ ok: true, index: 0, value: "ok" });
    expect(result[1]).toMatchObject({ ok: false, index: 1, message: "branch failed" });
    expect(ctx.issues).toEqual(["parallel job 2 failed: branch failed"]);
  });

  test("run passes input through", async () => {
    const ctx = createContext(tempRepo());
    const input = { value: 42 };

    const result = await ctx.run(async (received: typeof input) => received, input);

    expect(result).toBe(input);
  });

  test("run passes the current context to child sigils", async () => {
    const repo = tempRepo();
    const ctx = createContext(repo);
    const child = sigil("child", async (receivedCtx, input: { repo: string }) => ({
      repo: input.repo,
      receivedCurrentContext: receivedCtx === ctx,
    }));

    const result = await ctx.run(child, { repo });

    expect(result).toEqual({ repo, receivedCurrentContext: true });
  });

  test("sigil wrapper creates a context from input.repo for one-argument callers", async () => {
    const repo = tempRepo();
    const wrapped = sigil("probe", async (ctx, input: { repo: string }) => ({
      repo: input.repo,
      artifactDir: ctx.artifacts.dir,
    }));

    const result = await wrapped({ repo });

    expect(result).toEqual({ repo, artifactDir: artifactDir(repo) });
  });

  test("sigil wrapper passes the supplied context override through unchanged", async () => {
    const repo = tempRepo();
    const override: SigilContext = createContext(repo);
    const wrapped = sigil("probe", async (ctx, input: { repo: string }) => ({
      repo: input.repo,
      receivedOverride: ctx === override,
    }));

    const result = await wrapped({ repo }, override);

    expect(result).toEqual({ repo, receivedOverride: true });
  });

  test("await using disposes a SigilAgent on scope exit", async () => {
    let disposed = false;
    const makeAgent = (): SigilAgent => ({
      async prompt() {
        return "";
      },
      async close() {
        disposed = true;
      },
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    });

    async function scope(): Promise<boolean> {
      await using agent = makeAgent();
      await agent.prompt("noop");
      return disposed;
    }

    expect(await scope()).toBe(false);
    expect(disposed).toBe(true);
  });

  test("loadConfiguredContext reads present files in configured order and skips missing files", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.md"), "A context\n");
    writeFileSync(join(repo, "b.md"), "B context\n");

    const loaded = await loadConfiguredContext(repo, [
      { path: "b.md", update: true },
      { path: "missing.md", update: false },
      { path: "a.md", update: false },
    ]);

    expect(loaded.entries.map((entry) => entry.path)).toEqual(["b.md", "a.md"]);
    expect(loaded.entries.map((entry) => entry.contents)).toEqual(["B context\n", "A context\n"]);
    expect(loaded.entries[0].update).toBe(true);
    expect(loaded.skipped).toEqual([{ path: "missing.md", absolutePath: join(repo, "missing.md"), update: false, reason: "missing" }]);
  });

  test("context helper loads configured context from sigil config", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "sigil.config.json"), JSON.stringify({
      agents: { coder: { provider: "codex", model: "gpt-5.5" }, reviewer: { provider: "codex", model: "gpt-5.5" } },
      evals: {},
      context: [
        { path: "a.md", update: true },
        { path: "missing.md", update: false },
      ],
      plan: { planners: ["coder"], synthesizer: "reviewer" },
      implement: { coder: "coder", batchSize: 5, repairLimit: 3, branchPrefix: "sigil/", baseBranch: "main" },
      review: { reviewer: "reviewer" },
    }, null, 2));
    writeFileSync(join(repo, "a.md"), "Configured context\n");
    const ctx = createContext(repo);

    const loaded = await ctx.loadConfiguredContext();
    const rendered = await ctx.renderContextBlock();

    expect(loaded.entries.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(loaded.skipped.map((entry) => entry.path)).toEqual(["missing.md"]);
    expect(rendered).toContain("a.md (update: true)");
    expect(rendered).toContain("missing.md (update: false): missing");
  });

  test("loadConfiguredContext rejects absolute paths and repo escapes", async () => {
    const repo = tempRepo();

    await expect(loadConfiguredContext(repo, [{ path: join(repo, "a.md"), update: false }])).rejects.toThrow("repo-relative");
    await expect(loadConfiguredContext(repo, [{ path: "../escape.md", update: false }])).rejects.toThrow("escapes repo");
  });

  test("renderContextBlock includes update flags, contents, and missing notices", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "ARCHITECTURE.md"), "Current architecture\n");
    const rendered = renderContextBlock(await loadConfiguredContext(repo, [
      { path: "ARCHITECTURE.md", update: true },
      { path: "NOTES.md", update: false },
    ]));

    expect(rendered).toContain("ARCHITECTURE.md (update: true)");
    expect(rendered).toContain("Current architecture");
    expect(rendered).toContain("NOTES.md (update: false): missing");
  });
});
