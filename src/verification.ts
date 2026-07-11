import { isAbsolute, join } from "node:path";
import { readFile, rm } from "node:fs/promises";

import type { SigilConfig } from "./config.js";
import type { EvalGateResult } from "./gate.js";
import { diffFailures, parseFailingTests } from "./reports/junit.js";
import { recover, type RecoveryResult, type WorkflowFailure } from "./recovery/index.js";
import type { SigilContext } from "./context.js";

export type VerificationGate = {
  name: string;
  result: EvalGateResult;
};

export type VerificationResult = {
  ok: boolean;
  gates: VerificationGate[];
  evidence: string;
};

export type Baseline = {
  verification: VerificationResult;
  testFailures?: Set<string>;
};

export type VerificationRecovery = RecoveryResult<VerificationResult>;

export async function runBuildAndTest(ctx: SigilContext): Promise<VerificationResult> {
  return runGateSet(ctx, ["build", "test"]);
}

export async function runGateSet(
  ctx: SigilContext,
  names: readonly string[],
): Promise<VerificationResult> {
  const gates: VerificationGate[] = [];

  for (const name of names) {
    const result = await ctx.evals(name);
    gates.push({ name, result });
  }

  return summarize(gates);
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
