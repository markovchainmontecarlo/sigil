#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const fast = [
  "test/agent-operation.test.ts",
  "test/agents-schema.test.ts",
  "test/backlog.test.ts",
  "test/branch-slug.test.ts",
  "test/capacity-failover.test.ts",
  "test/claude-pty.test.ts",
  "test/claude-router.test.ts",
  "test/codex-circuits.test.ts",
  "test/codex-usage.test.ts",
  "test/config.test.ts",
  "test/contracts.test.ts",
  "test/contracts-import.test.ts",
  "test/dashboard-discovery.test.ts",
  "test/dashboard-read-run.test.ts",
  "test/dashboard-server.test.ts",
  "test/dashboard-snapshot.test.ts",
  "test/dispatch-state.test.ts",
  "test/documentation-commands.test.ts",
  "test/effective-config.test.ts",
  "test/environment-command.test.ts",
  "test/file-lock.test.ts",
  "test/gate.test.ts",
  "test/git.test.ts",
  "test/implementation-checkpoint.test.ts",
  "test/invariants.test.ts",
  "test/mastra.test.ts",
  "test/owned-pty-process.test.ts",
  "test/package-build.test.ts",
  "test/package-resources.test.ts",
  "test/public-exports.test.ts",
  "test/publication-artifact.test.ts",
  "test/process-group.test.ts",
  "test/prompts.test.ts",
  "test/provider-capabilities.test.ts",
  "test/provider-failure.test.ts",
  "test/provider-loading.test.ts",
  "test/provider-profiles.test.ts",
  "test/provider-telemetry.test.ts",
  "test/recovery.test.ts",
  "test/reports.test.ts",
  "test/scripts.test.ts",
  "test/server-run.test.ts",
  "test/sigil-skill.test.ts",
  "test/storage.test.ts",
  "test/verification.test.ts",
  "test/yaml-compile.test.ts",
  "test/yaml-run.test.ts",
  "test/yaml-validate.test.ts",
] as const;

const integration = [
  "test/breakdown.test.ts",
  "test/cli.test.ts",
  "test/codex-acp.test.ts",
  "test/codex-rate-limits.test.ts",
  "test/codex-router.test.ts",
  "test/context-agent.test.ts",
  "test/context.test.ts",
  "test/dispatch-delivery-resume.test.ts",
  "test/dispatch-initialization.test.ts",
  "test/dispatch-recovery-state.test.ts",
  "test/dispatch-resume.test.ts",
  "test/dispatch.test.ts",
  "test/implement.test.ts",
  "test/migrate.test.ts",
  "test/node-consumer.test.ts",
  "test/owned-process.test.ts",
  "test/plan.test.ts",
  "test/probe.test.ts",
  "test/profile-cli.test.ts",
  "test/refactor.test.ts",
  "test/review.test.ts",
  "test/sigil-runner.test.ts",
  "test/software-change.test.ts",
  "test/workspace.test.ts",
] as const;

const all = [...fast, ...integration] as const;
const suites = { fast, integration } as const;

function testFiles(): string[] {
  return readdirSync("test")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `test/${file}`)
    .sort();
}

function validateManifest(): void {
  const actual = testFiles();
  const declared = [...all].sort();
  const duplicates = declared.filter((file, index) => declared.indexOf(file) !== index);
  const missing = actual.filter((file) => !declared.includes(file));
  const stale = declared.filter((file) => !actual.includes(file));
  if (duplicates.length === 0 && missing.length === 0 && stale.length === 0) return;

  console.error(JSON.stringify({ duplicates, missing, stale }, null, 2));
  process.exit(2);
}

function selectedSuite(): readonly string[] {
  const name = process.argv[2] as keyof typeof suites | undefined;
  if (name && name in suites) return suites[name];

  console.error("usage: bun scripts/test-suite.ts <fast|integration> [bun test options]");
  process.exit(2);
}

validateManifest();
const files = selectedSuite();
const options = process.argv.slice(3);
const result = spawnSync("bun", ["test", ...files, ...options], { stdio: "inherit" });
process.exit(result.status ?? 1);
