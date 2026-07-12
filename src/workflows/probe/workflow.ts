import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { loadConfig, type SigilConfig } from "../../config.js";
import { CONTRACT_VERSION, validateTaskGraph } from "../../contracts/task-graph.js";
import { changedPaths } from "../../git.js";
import { loadConfiguredContext, renderContextBlock, sigil, type SigilContext } from "../../context.js";
import { enrichTaskGraph, repairTaskGraphJson, type TaskGraphCheck } from "../software-change/planning/task-graph.js";
import { probePrompts } from "./prompts.js";

export type ProbePlanInput = {
  intent: string;
  repo: string;
  brief?: string;
  outFile?: string;
  maxProbes?: number;
};
export type ProbeCommandResult = {
  id: string;
  title: string;
  hypothesis: string;
  command: string;
  expected: string;
  mutates: boolean;
  skipped: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  issue?: string;
};
export type ProbePlanResult = {
  taskFile: string;
  findingsFile: string;
  evidenceFile: string;
  sandboxDir: string;
  taskCount: number;
  valid: boolean;
  issues: string[];
};
type GraphCheck = TaskGraphCheck;
type ProbeSpec = z.infer<typeof ProbeSpecSchema>;

const DEFAULT_MAX_PROBES = 8;
const PROBE_TIMEOUT_MS = 60_000;
const ProbeSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  command: z.string().min(1),
  expected: z.string().min(1),
  mutates: z.boolean().default(false),
  rationale: z.string().min(1),
});
const ProbeListSchema = z.object({ probes: z.array(ProbeSpecSchema).min(1).max(12) });
const contract = JSON.stringify({
  contractVersion: CONTRACT_VERSION,
  project: "short-kebab-slug",
  goal: "string optional",
  tasks: [
    {
      id: "short-stable-id",
      title: "one-line title",
      summary: "what changes and why",
      dependencies: ["earlier-task-id"],
      acceptanceCriteria: ["observable check"],
      diagrams: ["optional ASCII diagram"],
      files: [
      {
        path: "repo/relative/path.ts",
        action: "create|modify|delete",
        details: ["symbol and line anchored detail"],
      },
    ],
    },
  ],
}, null, 2);

export const probePlan = sigil<ProbePlanInput, ProbePlanResult>("probe-plan", async (ctx, input) => {
  const config = loadConfig(input.repo);
  const initialPaths = await readChangedPaths(input.repo, ctx.issue);
  if (initialPaths.length) ctx.issue(`target working tree is already dirty; implement requires a clean tree: ${initialPaths.join(",")}`);
  const sandboxDir = await createSandbox(ctx, input.repo);
  const contextBlock = renderContextBlock(await loadConfiguredContext(input.repo, config.context));
  const taskFile = input.outFile ?? ctx.artifacts.path("probe-task-graph.json");
  const evidenceFile = ctx.artifacts.path("probe-evidence.md");
  const findingsFile = ctx.artifacts.path("probe-findings.md");

  try {
    const probes = await collectProbeSpecs(ctx, input, config, contextBlock, sandboxDir);
    const results = await runProbeCommands(
      ctx,
      probes.slice(0, input.maxProbes ?? DEFAULT_MAX_PROBES),
      sandboxDir,
    );
    await mkdir(dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, renderEvidence(input, sandboxDir, results));

    await synthesizeFindings(ctx, input, config, evidenceFile, findingsFile);
    const checked = await synthesizeTaskGraph(ctx, input, config, findingsFile, taskFile);
    await assertTargetTreePreserved(input.repo, initialPaths, ctx.issue);

    const valid = checked.errors.length === 0 && checked.raw !== null && ctx.issues.length === 0;
    if (valid) validateTaskGraph(checked.raw, { repoRoot: input.repo });
    return { taskFile, findingsFile, evidenceFile, sandboxDir, taskCount: checked.graph?.tasks.length ?? 0, valid, issues: [...ctx.issues] };
  } catch (error) {
    await assertTargetTreePreserved(input.repo, initialPaths, ctx.issue);
    return { taskFile, findingsFile, evidenceFile, sandboxDir, taskCount: 0, valid: false, issues: [...ctx.issues, message(error)] };
  }
});

async function collectProbeSpecs(
  ctx: SigilContext,
  input: ProbePlanInput & { repo: string },
  config: SigilConfig,
  contextBlock: string,
  sandboxDir: string,
): Promise<ProbeSpec[]> {
  const planned = await ctx.parallelSettled(
    config.plan.planners.map((name) => async () => {
    await using planner = ctx.agent(name);
    const prompt = probePrompts.design({
      INTENT: input.intent,
      BRIEF: input.brief ?? "",
      CONTEXT: contextBlock,
      TARGET_REPO: resolve(input.repo),
      SANDBOX_REPO: sandboxDir,
    });
    const result = await planner.prompt(prompt, ProbeListSchema);
    return result.probes;
    }),
  );

  return dedupeProbes(planned.flatMap((result) => (result.ok ? result.value : [])));
}

async function runProbeCommands(
  ctx: SigilContext,
  probes: ProbeSpec[],
  sandboxDir: string,
): Promise<ProbeCommandResult[]> {
  const results: ProbeCommandResult[] = [];
  for (const probe of probes) results.push(await runProbeCommand(ctx, probe, sandboxDir));
  return results;
}

async function runProbeCommand(
  ctx: SigilContext,
  probe: ProbeSpec,
  sandboxDir: string,
): Promise<ProbeCommandResult> {
  const blocked = unsafeCommandIssue(probe.command);
  if (blocked) return baseProbeResult(probe, { skipped: true, issue: blocked });

  const executed = await ctx.sh({
    command: "bash",
    args: ["-lc", probe.command],
    cwd: sandboxDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return {
    ...baseProbeResult(probe, { skipped: false }),
    ok: executed.exitCode === 0,
    exitCode: executed.exitCode,
    stdout: executed.stdout,
    stderr: executed.stderr,
  };
}

function baseProbeResult(probe: ProbeSpec, opts: { skipped: boolean; issue?: string }): ProbeCommandResult {
  return {
    id: probe.id,
    title: probe.title,
    hypothesis: probe.hypothesis,
    command: probe.command,
    expected: probe.expected,
    mutates: probe.mutates,
    skipped: opts.skipped,
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    issue: opts.issue,
  };
}

async function synthesizeFindings(
  ctx: SigilContext,
  input: ProbePlanInput & { repo: string },
  config: SigilConfig,
  evidenceFile: string,
  findingsFile: string,
): Promise<void> {
  await using synthesizer = ctx.agent(config.plan.synthesizer);
  const evidence = await readFile(evidenceFile, "utf8");
  const prompt = probePrompts.findings({
    INTENT: input.intent,
    BRIEF: input.brief ?? "",
    EVIDENCE: evidence,
    OUT_FILE: findingsFile,
  });
  const emitted = await ctx.emit(
    synthesizer,
    prompt,
    findingsFile,
    { minBytes: 1 },
  );
  if (!emitted.ok) ctx.issue(`probe findings synthesis failed: ${emitted.issue}`);
}

async function synthesizeTaskGraph(
  ctx: SigilContext,
  input: ProbePlanInput & { repo: string },
  config: SigilConfig,
  findingsFile: string,
  taskFile: string,
): Promise<GraphCheck> {
  await using synthesizer = ctx.agent(config.plan.synthesizer);
  const findings = await readFile(findingsFile, "utf8");
  await mkdir(dirname(taskFile), { recursive: true });

  const prompt = probePrompts.buildTaskGraph({
    INTENT: input.intent,
    FINDINGS: findings,
    CONTRACT: contract,
    OUT_FILE: taskFile,
  });
  const built = await ctx.emit(
    synthesizer,
    prompt,
    taskFile,
    { minBytes: 1, mustChange: true },
  );
  if (!built.ok) ctx.issue(`probe task graph synthesis failed: ${built.issue}`);

  await enrichTaskGraph(synthesizer, { intent: input.intent, taskFile });
  return repairTaskGraphJson(ctx, synthesizer, {
    taskFile,
    repo: input.repo,
    contract,
    issuePrefix: "probe task graph",
  });
}

async function createSandbox(ctx: SigilContext, repo: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "sigil-probe-"));
  const sandbox = join(parent, "repo");
  const cloned = await ctx.sh({
    command: "bash",
    args: ["-lc", `git clone --quiet --shared ${quote(resolve(repo))} ${quote(sandbox)}`],
    cwd: parent,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (cloned.exitCode !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`probe sandbox clone failed: ${cloned.stderr || cloned.stdout}`);
  }
  return sandbox;
}


async function readChangedPaths(repo: string, issue: (detail: string) => void): Promise<string[]> {
  try {
    return await changedPaths(repo);
  } catch (error) {
    issue(`could not read initial target tree status: ${message(error)}`);
    return [];
  }
}

async function assertTargetTreePreserved(repo: string, initialPaths: string[], issue: (detail: string) => void): Promise<void> {
  try {
    const finalPaths = await changedPaths(repo);
    if (JSON.stringify(finalPaths) !== JSON.stringify(initialPaths)) {
      issue(`probe changed target working tree: before=${initialPaths.join(",") || "clean"} after=${finalPaths.join(",") || "clean"}`);
    }
  } catch (error) {
    issue(`could not verify target tree cleanliness after probe: ${message(error)}`);
  }
}

function renderEvidence(input: ProbePlanInput, sandboxDir: string, results: ProbeCommandResult[]): string {
  const sections = results.map((result) => [
    `## ${result.id}: ${result.title}`,
    "",
    `Hypothesis: ${result.hypothesis}`,
    `Expected: ${result.expected}`,
    `Mutates sandbox: ${result.mutates}`,
    `Skipped: ${result.skipped}`,
    `Exit code: ${result.exitCode ?? "not run"}`,
    result.issue ? `Issue: ${result.issue}` : "",
    "",
    "Command:",
    "```sh",
    result.command,
    "```",
    "",
    "stdout:",
    "```",
    result.stdout.replace(/\s+$/, ""),
    "```",
    "",
    "stderr:",
    "```",
    result.stderr.replace(/\s+$/, ""),
    "```",
  ].filter(Boolean).join("\n"));

  return [`# Probe evidence`, "", `Intent: ${input.intent}`, `Sandbox repo: ${sandboxDir}`, "", ...sections, ""].join("\n");
}

function dedupeProbes(probes: ProbeSpec[]): ProbeSpec[] {
  const seen = new Set<string>();
  const unique: ProbeSpec[] = [];
  for (const probe of probes) {
    const key = probe.command.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(probe);
  }
  return unique;
}

function unsafeCommandIssue(command: string): string | undefined {
  if (/\bsudo\b|\bsu\b/.test(command)) return "probe command requires privilege escalation";
  if (/rm\s+-[^\n;|&]*r[^\n;|&]*f[^\n;|&]*(\/|~|\$HOME|\*)/.test(command)) return "probe command contains broad recursive deletion";
  return undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
