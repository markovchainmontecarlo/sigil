import { isAbsolute, join } from "node:path";
import { readFile, rm } from "node:fs/promises";

import { loadConfig, resolveEvalCommand, resolveEvalPlan, type SigilConfig } from "./config.js";
import type { EvalGateResult } from "./gate.js";
import { diffFailures, parseFailingTests } from "./reports/junit.js";
import { recover, type RecoveryResult, type WorkflowFailure } from "./recovery/index.js";
import type { SigilContext } from "./context.js";
import { repositoryStateDigest } from "./git.js";
import { createHash } from "node:crypto";
import type { Task } from "./contracts/task-graph.js";
import { extractFailureLog } from "./reports/failure-log.js";

export type VerificationGate = {
  name: string;
  result: EvalGateResult;
};

export type VerificationResult = {
  ok: boolean;
  gates: VerificationGate[];
  evidence: string;
  receipt?: VerificationReceipt;
};

export type VerificationReceipt = {
  repositoryState: string;
  gatePlan: string;
  environment: string;
};

export type Baseline = {
  verification: VerificationResult;
  testFailures?: Set<string>;
};

export type BaselineEvidence = {
  verification: VerificationResult;
  testFailures?: string[];
};

export type VerificationRecovery = RecoveryResult<VerificationResult>;

export function serializeBaseline(baseline: Baseline): BaselineEvidence {
  return {
    verification: baseline.verification,
    testFailures: baseline.testFailures ? [...baseline.testFailures].sort() : undefined,
  };
}

export function restoreBaseline(evidence: BaselineEvidence): Baseline {
  return {
    verification: evidence.verification,
    testFailures: evidence.testFailures ? new Set(evidence.testFailures) : undefined,
  };
}

export async function runBuildAndTest(ctx: SigilContext): Promise<VerificationResult> {
  return runGateSet(ctx, ["build", "test"]);
}

export async function runGateSet(
  ctx: SigilContext,
  names: readonly string[],
): Promise<VerificationResult> {
  const started = performance.now();
  const config = loadConfig(ctx.repo);
  const plan = resolveEvalPlan(names, config);
  const gates: VerificationGate[] = [];

  for (const name of plan) {
    const result = await ctx.evals(name);
    gates.push({ name, result });
  }

  const result = summarize(gates);
  result.receipt = await verificationReceipt(ctx.repo, plan, config);
  await ctx.observe("verification-completed", {
    gates: plan.join(","),
    outcome: result.ok ? "passed" : "failed",
    durationMs: String(Math.round(performance.now() - started)),
  });
  return result;
}

export async function verificationMatchesCurrentState(
  ctx: SigilContext,
  result: VerificationResult,
  names: readonly string[],
): Promise<boolean> {
  if (!result.receipt) return false;
  const config = loadConfig(ctx.repo);
  const plan = resolveEvalPlan(names, config);
  const current = await verificationReceipt(ctx.repo, plan, config);
  return result.receipt.repositoryState === current.repositoryState
    && result.receipt.gatePlan === current.gatePlan
    && result.receipt.environment === current.environment;
}

export async function refreshVerificationReceipt(
  ctx: SigilContext,
  result: VerificationResult,
  names: readonly string[],
): Promise<VerificationResult> {
  const config = loadConfig(ctx.repo);
  const plan = resolveEvalPlan(names, config);
  return { ...result, receipt: await verificationReceipt(ctx.repo, plan, config) };
}

export async function runTaskVerification(
  ctx: SigilContext,
  task: Task,
): Promise<VerificationResult> {
  const gates: VerificationGate[] = [];
  for (const [index, check] of task.verification.entries()) {
    const name = `task:${task.id}:${index + 1}`;
    if (check.kind === "manual") {
      await ctx.observe("gate-completed", {
        gate: name,
        outcome: "skipped",
        command: "manual",
        exitCode: "not-run",
        durationMs: "0",
      });
      continue;
    }

    const started = performance.now();
    await ctx.observe("gate-started", { gate: name, command: check.command });
    const result = await ctx.sh(check.command);
    const gate = {
      ok: result.ok,
      log: extractFailureLog([result.stdout, result.stderr].filter(Boolean).join("\n")),
      command: check.command,
      cwd: ctx.repo,
      exitCode: result.exitCode ?? undefined,
    };
    gates.push({ name, result: gate });
    await ctx.observe("gate-completed", {
      gate: name,
      outcome: gate.ok ? "passed" : "failed",
      command: check.command,
      exitCode: gate.exitCode === undefined ? "unknown" : String(gate.exitCode),
      durationMs: String(Math.round(performance.now() - started)),
    });
    if (!gate.ok) break;
  }
  return summarize(gates);
}

async function verificationReceipt(
  repo: string,
  plan: readonly string[],
  config: SigilConfig,
): Promise<VerificationReceipt> {
  return {
    repositoryState: await repositoryStateDigest(repo),
    gatePlan: digest(plan.map((name) => [name, resolveEvalCommand(name, config)])),
    environment: digest({
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      bun: Bun.version,
      environment: Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)),
    }),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function establishBaseline(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
): Promise<Baseline | WorkflowFailure> {
  await clearTestReport(config, repo);
  const verification = await runBuildAndTest(ctx);
  if (verification.ok) return { verification };

  const testFailures = await readFreshFailureSet(config, repo);
  if (testFailures) return { verification, testFailures };

  return failure("baseline", "baseline", verification.evidence, true);
}

export async function compareWithBaseline(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
  baseline: Baseline,
): Promise<VerificationResult> {
  await clearTestReport(config, repo);
  const current = await runBuildAndTest(ctx);
  return compareResultWithBaseline(repo, config, baseline, current);
}

export async function compareResultWithBaseline(
  repo: string,
  config: SigilConfig,
  baseline: Baseline,
  current: VerificationResult,
): Promise<VerificationResult> {
  if (current.ok) return current;
  if (!baseline.testFailures) return current;

  const currentFailures = await readFreshFailureSet(config, repo);
  if (!currentFailures) return current;
  const regressions = diffFailures(baseline.testFailures, currentFailures);
  if (regressions.size) {
    return {
      ...current,
      ok: false,
      evidence: `${current.evidence}\nnew failing tests: ${[...regressions].join(", ")}`,
    };
  }

  const build = current.gates.find((gate) => gate.name === "build")?.result;
  return { ...current, ok: build?.skipped !== false || build.ok };
}

export async function verifyWithRepair(options: {
  ctx: SigilContext;
  stage: string;
  limit: number;
  verify: () => Promise<VerificationResult>;
  repair: (failure: WorkflowFailure, attempt: number) => Promise<void>;
}): Promise<VerificationRecovery> {
  return recover({
    limit: options.limit,
    attempt: async () => {
      const result = await options.verify();
      if (result.ok) return { ok: true, value: result };
      return {
        ok: false,
        failure: failure("gate", options.stage, result.evidence, true),
      };
    },
    repair: async (current, attempt) => {
      await options.ctx.observe("repair-started", {
        stage: options.stage,
        attempt: String(attempt),
      });
      await options.repair(current, attempt);
      await options.ctx.observe("repair-completed", {
        stage: options.stage,
        attempt: String(attempt),
      });
    },
    record: async (current) => options.ctx.observe("verification-failed", {
      stage: current.stage,
      kind: current.kind,
      attempt: String(current.attempts),
    }),
  });
}

function summarize(gates: VerificationGate[]): VerificationResult {
  const configured = gates.filter((gate) => !gate.result.skipped);
  const ok = configured.length > 0 && configured.every((gate) => gate.result.ok);
  const evidence = gates
    .filter((gate) => !gate.result.skipped)
    .map((gate) => `${gate.name}: ${gate.result.ok ? "passed" : "failed"}\n${gate.result.log}`)
    .join("\n");
  return { ok, gates, evidence };
}

async function readFreshFailureSet(
  config: SigilConfig,
  repo: string,
): Promise<Set<string> | undefined> {
  const report = config.implement.testReport;
  if (!report) return undefined;
  const path = isAbsolute(report.path) ? report.path : join(repo, report.path);
  try {
    const contents = await readFile(path, "utf8");
    if (!contents.includes("<test")) return undefined;
    return parseFailingTests(contents, report.format);
  } catch {
    return undefined;
  }
}

export async function clearTestReport(config: SigilConfig, repo: string): Promise<void> {
  const report = config.implement.testReport;
  if (!report) return;
  const path = isAbsolute(report.path) ? report.path : join(repo, report.path);
  await rm(path, { force: true });
}

function failure(
  kind: WorkflowFailure["kind"],
  stage: string,
  evidence: string,
  recoverable: boolean,
): WorkflowFailure {
  return { kind, stage, evidence, attempts: 0, recoverable };
}
