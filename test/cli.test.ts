import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { implementExitCode, reviewExitCode, softwareChangeExitCode } from "../src/commands/exit-codes.js";
import { commandHelps } from "../src/help.js";
import { DEFAULT_SIGIL_CONFIG, loadConfig } from "../src/config.js";
import { CONTRACT_VERSION, type Task, type TaskGraph } from "../src/contracts/task-graph.js";

const file = (path = "/repo/src/file.ts") => ({ path, action: "modify" as const, details: ["update file"] });
const task = (id: string, dependencies: string[] = []): Task => ({
  id,
  title: `Task ${id}`,
  summary: `Summary ${id}`,
  dependencies,
  acceptanceCriteria: ["works"],
  diagrams: [],
  files: [file(`/repo/src/${id}.ts`)],
});
const graph = (tasks: Task[]): TaskGraph => ({ contractVersion: CONTRACT_VERSION, project: "fixture", tasks });

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync({ cmd: ["bun", "src/cli.ts", ...args], cwd: process.cwd(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("cli", () => {
  test("validate exits 0 and prints [] for a valid task graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-"));
    const taskFile = join(dir, "valid.json");
    writeFileSync(taskFile, JSON.stringify(graph([task("a"), task("b", ["a"])])));

    const result = run(["validate", taskFile]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result.stdout))).toEqual([]);
  });

  test("validate exits 1 and prints errors for an invalid task graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-"));
    const taskFile = join(dir, "invalid.json");
    writeFileSync(taskFile, JSON.stringify(graph([{ ...task("a"), files: [file("../outside.ts")] }])));

    const result = run(["validate", "--repo", dir, taskFile]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(stdout).toContain("file path escapes repo root");
  });

  test("validate resolves repo-relative task paths against --repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-"));
    const taskFile = join(dir, "valid-relative.json");
    writeFileSync(taskFile, JSON.stringify(graph([{ ...task("a"), files: [file("src/a.ts")] }])));

    const result = run(["validate", "--repo", dir, taskFile]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result.stdout))).toEqual([]);
  });

  test("validate-workflow exits 0 and prints [] for a valid static workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-yaml-"));
    const workflowFile = join(dir, "workflow.yaml");
    writeFileSync(
      workflowFile,
      [
        "name: deterministic-demo",
        "stages:",
        "  - id: report",
        "    jobs:",
        "      - id: render",
        "        steps:",
        "          - id: hello",
        "            script: echo hello",
      ].join("\n"),
    );

    const result = run(["validate-workflow", workflowFile]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result.stdout))).toEqual([]);
  });

  test("run-workflow exits 0 and prints stage results for a deterministic workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-yaml-"));
    const workflowFile = join(dir, "workflow.yaml");
    writeFileSync(
      workflowFile,
      [
        "name: deterministic-demo",
        "stages:",
        "  - id: report",
        "    jobs:",
        "      - id: render",
        "        steps:",
        "          - id: hello",
        "            script: echo hello",
      ].join("\n"),
    );

    const result = run(["run-workflow", "--repo", dir, "--file", workflowFile]);
    const output = JSON.parse(text(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(output.workflow).toBe("deterministic-demo");
    expect(output.stageResults[0].jobResults[0].stepResults[0].output).toBe("hello");
  });

  test("no arguments exits 2 and prints usage naming every subcommand", () => {
    const result = run([]);
    const stderr = text(result.stderr);

    expect(result.exitCode).toBe(2);
    for (const command of [
      "migrate",
      "dashboard",
      "probe",
      "plan",
      "software-change",
      "implement",
      "review",
      "breakdown",
      "dispatch",
      "validate",
      "validate-workflow",
      "validate-sigil",
      "run-workflow",
      "run-sigil",
      "setup",
      "discover-env",
      "config",
      "profile",
    ]) {
      expect(stderr).toContain(command);
    }
  });

  test("dashboard help describes its read-only loopback boundary", () => {
    const result = run(["dashboard", "--help"]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("read-only live dashboard");
    expect(stdout).toContain("--host <loopback>");
  });

  test("global help exits 0 and names only public CLI commands", () => {
    const result = run(["--help"]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    for (const command of [
      "migrate",
      "probe",
      "plan",
      "software-change",
      "implement",
      "review",
      "breakdown",
      "dispatch",
      "validate",
      "validate-workflow",
      "validate-sigil",
      "run-workflow",
      "run-sigil",
      "setup",
      "discover-env",
      "config",
      "profile",
    ]) {
      expect(stdout).toContain(`sigil ${command}`);
    }
  });

  test("config show prints effective configuration in JSON and human modes", () => {
    const repo = mkdtempSync(join(tmpdir(), "sigil-cli-config-"));
    writeFileSync(join(repo, "sigil.config.json"), JSON.stringify(DEFAULT_SIGIL_CONFIG));

    const json = run(["config", "show", "--effective", "--repo", repo, "--json"]);
    const human = run(["config", "show", "--effective", "--repo", repo]);

    expect(json.exitCode).toBe(0);
    expect(JSON.parse(text(json.stdout))).toMatchObject({ version: 1, kind: "effective-config" });
    expect(human.exitCode).toBe(0);
    expect(text(human.stdout)).toContain("no assignment predicted");
  });

  test("config rejects incomplete usage and missing configuration", () => {
    const usage = run(["config", "show"]);
    const repo = mkdtempSync(join(tmpdir(), "sigil-cli-config-missing-"));
    const missing = run(["config", "show", "--effective", "--repo", repo]);

    expect(usage.exitCode).toBe(2);
    expect(missing.exitCode).toBe(1);
  });

  test("per-command help exits 0 and names each command's flags", () => {
    for (const help of commandHelps) {
      const result = run([help.name, "--help"]);
      const stdout = text(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain(`Usage: ${help.usage}`);
      for (const flag of help.flags) expect(stdout).toContain(flag.name);
      expect(stdout).toContain("Exit codes:");
    }
  }, 15000);

  test("codex-profile is not a command or compatibility alias", () => {
    const result = run(["codex-profile", "list"]);
    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).not.toContain("sigil codex-profile");
  });



  test("software-change is a public CLI help command", () => {
    const result = run(["software-change", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Usage: sigil software-change");
    expect(text(result.stdout)).toContain("--task-file <file>");
    expect(text(result.stdout)).toContain("--instructions <file>");
  });

  test("probe is a public CLI help command", () => {
    const result = run(["probe", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Usage: sigil probe");
    expect(text(result.stdout)).toContain("--max-probes <n>");
  });

  test("dispatch and breakdown are public CLI help commands", () => {
    const dispatch = run(["dispatch", "--help"]);
    const breakdown = run(["breakdown", "--help"]);

    expect(dispatch.exitCode).toBe(0);
    expect(text(dispatch.stdout)).toContain("Usage: sigil dispatch");
    expect(breakdown.exitCode).toBe(0);
    expect(text(breakdown.stdout)).toContain("Usage: sigil breakdown");
  });

  test("validate-workflow and run-workflow are public CLI help commands", () => {
    const validateWorkflow = run(["validate-workflow", "--help"]);
    const runWorkflow = run(["run-workflow", "--help"]);

    expect(validateWorkflow.exitCode).toBe(0);
    expect(text(validateWorkflow.stdout)).toContain("Usage: sigil validate-workflow");
    expect(runWorkflow.exitCode).toBe(0);
    expect(text(runWorkflow.stdout)).toContain("Usage: sigil run-workflow");
  });

  test("validate-sigil is a public CLI help command", () => {
    const result = run(["validate-sigil", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Usage: sigil validate-sigil");
  });

  test("validate-sigil exits 0 with an empty error array for a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-validate-sigil-"));
    const workflowFile = join(dir, "workflow.ts");
    writeFileSync(workflowFile, "export default async () => ({ ok: true });");

    const result = run(["validate-sigil", workflowFile]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result.stdout))).toEqual([]);
  });

  test("validate-sigil exits 1 with errors for an invalid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-validate-sigil-"));
    const workflowFile = join(dir, "workflow.ts");
    writeFileSync(workflowFile, "export const value = 1;");

    const result = run(["validate-sigil", workflowFile]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stdout)).toContain("missing callable workflow export");
  });

  test("validate-sigil incorrect positional arguments exit 2", () => {
    const result = run(["validate-sigil"]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("run-sigil is a public CLI help command", () => {
    const result = run(["run-sigil", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain("Usage: sigil run-sigil");
    expect(text(result.stdout)).toContain("--run-dir <dir>");
    expect(text(result.stdout)).toContain("--persistence durable|ephemeral");
  });

  test("run-sigil missing required flags exits 2 with usage on stderr", () => {
    const result = run(["run-sigil", "--repo", "."]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("run-sigil returns a detached handle and writes the eventual result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-run-sigil-"));
    const workflowFile = join(dir, "workflow.ts");
    const inputFile = join(dir, "input.json");
    const outFile = join(dir, "result.json");
    writeFileSync(workflowFile, "export default async (input: { repo: string; value: string }) => ({ repo: input.repo, value: input.value });");
    writeFileSync(inputFile, JSON.stringify({ value: "ok" }));

    const result = run([
      "run-sigil",
      "--repo",
      dir,
      "--file",
      workflowFile,
      "--input",
      inputFile,
      "--out",
      outFile,
      "--persistence",
      "ephemeral",
    ]);
    const handle = JSON.parse(text(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(handle.state).toBe("started");
    expect(handle.pid).toBeGreaterThan(0);
    for (
      let attempt = 0;
      attempt < 100 && JSON.parse(readFileSync(handle.statusFile, "utf8")).state !== "succeeded";
      attempt++
    ) {
      await Bun.sleep(20);
    }
    expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual({ repo: dir, value: "ok" });
    expect(JSON.parse(readFileSync(handle.statusFile, "utf8")).state).toBe("succeeded");
  });

  test("run-sigil durable mode rejects temporary workflow state", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-run-sigil-durable-"));
    const workflowFile = join(dir, "workflow.ts");
    writeFileSync(workflowFile, "export default async () => ({ ok: true });");

    const result = run(["run-sigil", "--repo", dir, "--file", workflowFile]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).toContain("durable run refused");
  });

  test("run-sigil defaults durable runs to the repository run directory", async () => {
    const dir = mkdtempSync(join(homedir(), ".sigil-cli-run-sigil-durable-"));
    const workflowFile = join(dir, "workflow.ts");
    writeFileSync(workflowFile, "export default async () => ({ ok: true });");

    const result = run(["run-sigil", "--repo", dir, "--file", workflowFile]);
    const handle = JSON.parse(text(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(handle.runDir.startsWith(join(dir, ".sigil", "runs"))).toBe(true);
    for (
      let attempt = 0;
      attempt < 100 && JSON.parse(readFileSync(handle.statusFile, "utf8")).state !== "succeeded";
      attempt++
    ) {
      await Bun.sleep(20);
    }
    expect(JSON.parse(readFileSync(handle.statusFile, "utf8")).state).toBe("succeeded");

    rmSync(dir, { recursive: true, force: true });
  });

  test("migrate rejects temporary checkpoint storage", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-migrate-durable-"));

    const result = run([
      "migrate",
      "--repo",
      dir,
      "--target",
      join(dir, "target.md"),
      "--backlog",
      join(dir, "backlog.json"),
      "--run-dir",
      join(dir, "run"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).toContain("durable run refused");
  });

  test("dispatch missing backlog exits 2 with usage on stderr", () => {
    const result = run(["dispatch", "--repo", "."]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("dispatch bogus policy exits 2 with usage on stderr", () => {
    const result = run(["dispatch", "--repo", ".", "--backlog", "x", "--policy", "bogus"]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("dispatch requires an explicit delivery policy", () => {
    const result = run(["dispatch", "--repo", ".", "--backlog", "x"]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("integration-branch policy requires its target branch", () => {
    const result = run([
      "dispatch",
      "--repo",
      ".",
      "--backlog",
      "x",
      "--policy",
      "integrationBranch",
    ]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("breakdown missing mission exits 2 with usage on stderr", () => {
    const result = run(["breakdown", "--repo", "."]);

    expect(result.exitCode).toBe(2);
    expect(text(result.stderr)).toContain("Usage:");
  });

  test("discover-env reports safe role and transport prerequisites in human and JSON modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-discover-"));
    writeFileSync(join(dir, "sigil.config.json"), JSON.stringify({
      agents: { claudeReviewer: { provider: "claude", model: "private-model" } },
      evals: {}, context: [],
      plan: { planners: ["claudeReviewer"], synthesizer: "claudeReviewer" },
      implement: { coder: "claudeReviewer", batchSize: 1, repairLimit: 1, branchPrefix: "sigil/", baseBranch: "main" },
      review: { reviewers: ["claudeReviewer"], synthesizer: "claudeReviewer" },
    }));
    const home = mkdtempSync(join(tmpdir(), "sigil-cli-home-"));
    const registry = join(home, "claude-profiles/registry.json");
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(registry, JSON.stringify({ version: 1, profiles: [
      { provider: "claude", name: "private-name", enabled: true, accessClass: "subscription", details: { configurationDirectory: "/private/missing" } },
      { provider: "claude", name: "api", enabled: true, accessClass: "metered-api", mode: "manual", admission: { startLimit: 1 }, operation: { usdLimit: 1 }, details: { credentialSource: "SECRET_ENV" } },
    ] }));
    chmodSync(registry, 0o600);

    const human = run(["discover-env", "--repo", dir], { SIGIL_HOME: home, SECRET_ENV: "secret-value" });
    const json = run(["discover-env", "--repo", dir, "--json"], { SIGIL_HOME: home, SECRET_ENV: "secret-value" });
    const output = text(human.stdout) + text(json.stdout);

    expect(human.exitCode).toBe(0);
    expect(json.exitCode).toBe(0);
    expect(text(human.stdout)).toContain("prerequisite check only");
    expect(JSON.parse(text(json.stdout))).toMatchObject({ version: 1, kind: "environment-prerequisites" });
    expect(output).toContain("claude-cli-pty");
    expect(output).toContain("claude-agent-sdk");
    for (const secret of ["private-model", "private-name", "/private/missing", "SECRET_ENV", "secret-value"]) expect(output).not.toContain(secret);
  });

  test("discover-env reports missing config without a stack trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-discover-empty-"));

    const result = run(["discover-env", "--repo", dir]);
    const stderr = text(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(`Missing ${join(dir, "sigil.config.json")}`);
    expect(stderr).not.toContain("Error:");
  });


  test("setup writes a default config that loadConfig can parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-setup-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

    const result = run(["setup", "--dir", dir]);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain(join(dir, "sigil.config.json"));
    expect(loadConfig(dir)).toEqual(DEFAULT_SIGIL_CONFIG);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n/.sigil/runs/\n");
  });

  test("setup refuses existing config unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-setup-"));
    const configPath = join(dir, "sigil.config.json");

    const first = run(["setup", "--dir", dir]);
    expect(first.exitCode).toBe(0);
    const firstBody = readFileSync(configPath, "utf8");

    const second = run(["setup", "--dir", dir]);
    expect(second.exitCode).toBe(1);
    expect(text(second.stderr)).toContain("already exists");
    expect(readFileSync(configPath, "utf8")).toBe(firstBody);

    writeFileSync(configPath, "{\n  \"not\": \"the default\"\n}\n");
    const forced = run(["setup", "--dir", dir, "--force"]);

    expect(forced.exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(firstBody);
    expect(loadConfig(dir)).toEqual(DEFAULT_SIGIL_CONFIG);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("/.sigil/runs/\n");
  });

  test("bogus subcommand exits 2", () => {
    const result = run(["bogus"]);

    expect(result.exitCode).toBe(2);
  });



  test("software-change task-file mode validates the supplied graph before planning", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-cli-software-change-"));
    const taskFile = join(dir, "invalid-task-graph.json");
    writeFileSync(taskFile, JSON.stringify({ contractVersion: CONTRACT_VERSION, project: "fixture", tasks: [] }));

    const result = run(["software-change", "--repo", dir, "--intent", "Use the ready graph.", "--task-file", taskFile]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).toContain("task graph has no tasks");
  });

  test("software-change exit code fails on invalid result or reported issues", () => {
    expect(softwareChangeExitCode({ valid: false, issues: [] })).toBe(1);
    expect(softwareChangeExitCode({ valid: true, issues: ["gate failed"] })).toBe(1);
    expect(softwareChangeExitCode({ valid: true, issues: [] })).toBe(0);
  });

  test("implement exit code fails when implementation reports failed tasks or issues", () => {
    const published = { push: { ok: true, log: "" }, pr: { ok: true, log: "" } };

    expect(implementExitCode({ reviewBlocking: false, failedTasks: ["a"], issues: [] }, published)).toBe(1);
    expect(implementExitCode({ reviewBlocking: false, failedTasks: [], issues: ["gate failed"] }, published)).toBe(1);
    expect(implementExitCode({ reviewBlocking: false, failedTasks: [], issues: [] }, { push: { ok: true, log: "" }, pr: { ok: false, log: "no pr" } })).toBe(1);
    expect(implementExitCode({ reviewBlocking: false, failedTasks: [], issues: [] }, published)).toBe(0);
  });

  test("review exits 1 when review reports issues without unresolved highs", () => {
    expect(reviewExitCode({ valid: false, unresolvedHigh: 0, issues: ["git diff failed"] })).toBe(1);
  });

  test("review subcommand exits 1 when diff setup fails", () => {
    const result = run(["review", "--repo", ".", "--base", "definitely-not-a-ref"]);

    expect(result.exitCode).toBe(1);
    expect(text(result.stdout)).toContain("fatal: bad revision");
  });
});
