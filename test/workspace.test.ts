import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { bootstrapWorkspace } from "../src/workspace.js";

function repository(bootstrap: string, ready?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "sigil-workspace-"));
  const config = {
    agents: { coder: { provider: "codex", model: "test" } },
    evals: {},
    workspace: { bootstrap, ...(ready ? { ready } : {}) },
    plan: { planners: ["coder"], synthesizer: "coder" },
    implement: { coder: "coder", sessionTaskLimit: 1, repairLimit: 1, branchPrefix: "x/", baseBranch: "main" },
    review: { reviewers: ["coder"], synthesizer: "coder" },
  };
  writeFileSync(join(repo, "sigil.config.json"), JSON.stringify(config));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

describe("workspace bootstrap", () => {
  test("serializes one bootstrap and rechecks readiness after locking", async () => {
    const script = [
      "const fs=require('fs')",
      "const p='.git/bootstrap-count'",
      "fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p):0)+1))",
      "setTimeout(()=>fs.writeFileSync('.git/ready','yes'),60)",
    ].join(";");
    const repo = repository(
      `node -e ${JSON.stringify(script)}`,
      "test -f .git/ready",
    );
    const config = loadConfig(repo);
    const first = createContext(repo, { artifactRoot: mkdtempSync(join(tmpdir(), "sigil-run-a-")) });
    const second = createContext(repo, { artifactRoot: mkdtempSync(join(tmpdir(), "sigil-run-b-")) });

    await Promise.all([
      bootstrapWorkspace(first, repo, config),
      bootstrapWorkspace(second, repo, config),
    ]);

    expect(readFileSync(join(repo, ".git", "bootstrap-count"), "utf8")).toBe("1");
  });

  test("failed readiness runs bootstrap and bootstrap failures retain evidence", async () => {
    const repo = repository("printf bootstrap-failed >&2; exit 7", "false");

    await expect(bootstrapWorkspace(createContext(repo), repo, loadConfig(repo)))
      .rejects.toThrow("bootstrap-failed");
  });

  test("tracked mutations retain the clean-tree failure", async () => {
    const repo = repository("printf changed > sigil.config.json");

    await expect(bootstrapWorkspace(createContext(repo), repo, loadConfig(repo)))
      .rejects.toThrow("workspace bootstrap changed tracked repository files");
  });

  test("cancellation releases the checkout lock for a later caller", async () => {
    const repo = repository("node -e \"setInterval(()=>{},1000)\"");
    const abort = new AbortController();
    const cancelled = bootstrapWorkspace(
      createContext(repo, { signal: abort.signal }),
      repo,
      loadConfig(repo),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await expect(cancelled).rejects.toThrow("workspace bootstrap failed");

    const config = loadConfig(repo);
    config.workspace.bootstrap = "true";
    await expect(bootstrapWorkspace(createContext(repo), repo, config)).resolves.toBeUndefined();
  });
});
