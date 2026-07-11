import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { promptAgentWithRecovery, runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig, type SigilConfig } from "../../../config.js";
import { planBatches, validateTaskGraph, type Task, type TaskGraph } from "../../../contracts/task-graph.js";
import { changedPaths, checkoutFreshBranch, commitAll, git, isCleanTree, type CommitResult } from "../../../git.js";
import { loadConfiguredContext, renderContextBlock, sigil, type RichSigilAgent, type SigilContext } from "../../../context.js";
import { implementationPrompts } from "./prompts.js";
import {
  compareWithBaseline,
  establishBaseline,
  runGateSet,
  runBuildAndTest,
  type Baseline,
  type VerificationResult,
} from "../../../verification.js";
import { review } from "../review/index.js";
import { bootstrapWorkspace } from "../../../workspace.js";

export type ImplementInput = {
  taskFile: string;
  repo: string;
  branch?: string;
  baseBranch?: string;
  instructions?: string;
};
export type ImplementResult = { branch: string; prBody: string; reviewBlocking: boolean; issues: string[]; failedTasks: string[]; noopTasks: string[] };

type ArtifactPath = (name: string) => string;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function taskPrompt(task: Task, contextBlock: string): string {
  return implementationPrompts.task({
    PREAMBLE: implementationPrompts.preamble(),
    TASK_ID: task.id,
    TASK_TITLE: task.title,
    TASK_SUMMARY: task.summary,
    CONTEXT: contextBlock,
    DIAGRAMS: task.diagrams.join("\n"),
    ACCEPTANCE: task.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    FILES: task.files.map((f) => `- ${f.action} ${f.path}\n${f.details.map((d) => `  - ${d}`).join("\n")}`).join("\n"),
  });
}

function runInstructionsBlock(instructions: string | undefined): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return "";

  return [
    "## Run instructions",
    "",
    "These instructions apply to this implementation run. Use them as execution guidance, then verify claims against the repository before changing code.",
    "",
    trimmed,
  ].join("\n");
}

function implementationContextBlock(configuredContext: string, instructions: string | undefined): string {
  return [configuredContext, runInstructionsBlock(instructions)].filter(Boolean).join("\n\n");
}

function reviewContext(graph: TaskGraph, instructions: string | undefined): string {
  return [
    graph.goal ?? "",
    graph.tasks.map((t) => `${t.id}: ${t.title}`).join("\n"),
    runInstructionsBlock(instructions),
  ].filter(Boolean).join("\n\n");
}

async function promptWithRecovery(
  ctx: SigilContext,
  agent: RichSigilAgent,
  config: SigilConfig,
  stage: string,
  prompt: string,
): Promise<string> {
  const result = await promptAgentWithRecovery(ctx, agent, prompt, {
    stage,
    limit: config.implement.repairLimit,
    timeoutMs: config.implement.operationTimeoutMs,
  });
  if (!result.ok) throw new Error(result.failure.evidence);
  return result.value;
}

async function repair(
  ctx: SigilContext,
  agent: RichSigilAgent,
  config: SigilConfig,
  stage: string,
  context: string,
  command: string,
  log: string,
): Promise<string> {
  return promptWithRecovery(ctx, agent, config, stage, implementationPrompts.repair({ CONTEXT: context, COMMAND: command, LOG: log }));
}

async function commitTask(repo: string, task: Task, issues: string[]): Promise<CommitResult> {
  const result = await commitAll(repo, `${task.id}: ${task.title}`);
  if (result.status === "failed") issues.push(`commit failed for ${task.id}: ${result.log}`);
  if (result.hooksBypassed) issues.push(`commit for ${task.id} bypassed hooks`);
  return result;
}

function noopSatisfied(text: string): boolean {
  return /^\s*NOOP-CHECK\s*:\s*SATISFIED\s*$/m.test(text);
}

export function slugifyBranch(value: string): string {
  const base = value.split(/[/\\]/).filter(Boolean).pop() ?? value;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return cleaned || "implement";
}

function branchName(config: SigilConfig, input: ImplementInput, graph: TaskGraph): string {
  return input.branch ?? `${config.implement.branchPrefix}${slugifyBranch(graph.project || "implement")}`;
}

function prBody(issues: string[], reviewBlocking: boolean): string {
  const header = reviewBlocking ? "# BLOCKING: review or gate failures remain\n\n" : "";
  const issueList = issues.length ? issues.map((issue) => `- ${issue}`).join("\n") : "- none";
  return `${header}## Issues\n${issueList}\n`;
}

async function recordTaskScopeIssues(repo: string, task: Task, config: SigilConfig, issues: string[]): Promise<void> {
  const changed = await changedPaths(repo);
  const unverifiedTests = changed.filter((path) => /\.(spec|test)\.[jt]sx?$/.test(path));
  if (unverifiedTests.length && !("test" in config.evals)) {
    issues.push(`task ${task.id} touched test files but no test eval is configured; those tests were never run: ${unverifiedTests.join(", ")}`);
  }
}

function taskReplyArtifactName(taskId: string): string {
  return `${encodeURIComponent(taskId)}.md`;
}

async function persistTaskReply(artifactPath: ArtifactPath, task: Task, reply: string, noopVerdict: string | undefined, issues: string[]): Promise<void> {
  const dir = artifactPath("implement-replies");
  const body = noopVerdict === undefined ? reply : `${reply}\n\n## noop-check\n\n${noopVerdict}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, taskReplyArtifactName(task.id)), body, "utf8");
  } catch (error) {
    issues.push(`task ${task.id} reply artifact write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type NoopRecovery =
  | { status: "completed"; reply: string; verdict: string }
  | { status: "satisfied"; reply: string; verdict: string }
  | { status: "failed"; reply: string; verdict: string; evidence: string };

async function recoverNoop(
  ctx: SigilContext,
  coder: RichSigilAgent,
  config: SigilConfig,
  repo: string,
  task: Task,
  initialReply: string,
): Promise<NoopRecovery> {
  let reply = initialReply;
  let verdict = "";

  for (let attempt = 1; attempt <= config.implement.repairLimit + 1; attempt++) {
    const checked = await runFreshAgentOperation(
      ctx,
      config.implement.coder,
      {
        stage: `task:${task.id}:noop-check`,
        limit: config.implement.repairLimit,
        timeoutMs: config.implement.operationTimeoutMs,
      },
      (checker) => checker.prompt(implementationPrompts.noopCheck({
        TASK_ID: task.id,
        TASK_TITLE: task.title,
        ACCEPTANCE: task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
      })),
    );
    if (!checked.ok) {
      return { status: "failed", reply, verdict, evidence: checked.failure.evidence };
    }
    verdict = checked.value;
    if (noopSatisfied(verdict)) return { status: "satisfied", reply, verdict };
    if (attempt > config.implement.repairLimit) {
      return {
        status: "failed",
        reply,
        verdict,
        evidence: `task ${task.id} remained unsatisfied after no-op repair: ${verdict}`,
      };
    }

    reply = await repair(
      ctx,
      coder,
      config,
      `task:${task.id}:noop-repair`,
      `The independent no-op checker found task ${task.id} incomplete. Repair every missing acceptance criterion while preserving task intent.`,
      "configured build/test gates",
      verdict,
    );
    const gate = await runBuildAndTest(ctx);
    if (!gate.ok) continue;
    const commit = await commitAll(repo, `${task.id}: ${task.title}`);
    if (commit.status === "failed") {
      return { status: "failed", reply, verdict, evidence: commit.log };
    }
    if (commit.status === "committed") return { status: "completed", reply, verdict };
  }

  return { status: "failed", reply, verdict, evidence: `task ${task.id} no-op recovery exhausted` };
}

export const implement = sigil<ImplementInput, ImplementResult>("implement", async (ctx, input) => {
  const config = loadConfig(input.repo);
  const graph = validateTaskGraph(await readJson(input.taskFile), { repoRoot: input.repo });
  const { batches, byId } = planBatches(graph.tasks, config.implement.batchSize);
  if (!(await isCleanTree(input.repo))) throw new Error("working tree is not clean");

  const baseBranch = input.baseBranch ?? config.implement.baseBranch;
  const branch = branchName(config, input, graph);
  await checkoutFreshBranch(input.repo, branch, baseBranch);
  await bootstrapWorkspace(ctx, input.repo, config);
  const loadedContext = await loadConfiguredContext(input.repo, config.context);
  const contextBlock = implementationContextBlock(renderContextBlock(loadedContext), input.instructions);
  const baselineSha = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
  if (!baselineSha) throw new Error("failed to record baseline sha");
  const baselineResult = await establishBaseline(ctx, input.repo, config);

  const issues: string[] = [];
  const failed = new Set<string>();
  const noopTasks: string[] = [];

  if ("kind" in baselineResult) {
    const failedTasks = graph.tasks.map((task) => task.id);
    issues.push(`baseline could not be established: ${baselineResult.evidence}`);
    return {
      branch,
      prBody: prBody(issues, true),
      reviewBlocking: true,
      issues,
      failedTasks,
      noopTasks,
    };
  }
  const baseline = baselineResult;

  for (const batch of batches) {
    {
      await using coder = ctx.agent(config.implement.coder);
      for (const id of batch) {
        const task = byId[id];
        await ctx.observe("task-started", { task: id });
        if (task.dependencies.some((dep) => failed.has(dep))) {
          failed.add(id);
          issues.push(`task ${id} skipped because a dependency failed`);
          await ctx.observe("task-skipped", { task: id, reason: "dependency-failed" });
          continue;
        }

        const checkpoint = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
        let reply = "";
        let noopVerdict: string | undefined;
        try {
          reply = await promptWithRecovery(ctx, coder, config, `task:${id}:implement`, taskPrompt(task, contextBlock));
          let gate = await runBuildAndTest(ctx);
          for (let attempt = 0; !gate.ok && attempt < config.implement.repairLimit; attempt++) {
            reply = await repair(ctx, coder, config, `task:${id}:gate-repair`, `Task ${id} failed build/test. Follow relevant repository dependencies while preserving task intent.`, "configured build/test gates", gate.evidence);
            gate = await runBuildAndTest(ctx);
          }
          if (!gate.ok) {
            failed.add(id);
            issues.push(`task ${id} failed gates: ${gate.evidence}`);
            await preserveAndRestoreTaskFailure(ctx, input.repo, task, checkpoint, "build-test", gate.evidence);
            await ctx.observe("task-failed", { task: id, stage: "build-test" });
            continue;
          }

          await recordTaskScopeIssues(input.repo, task, config, issues);
          let commit = await commitTask(input.repo, task, issues);
          if (commit.status === "nothing" && task.files.length) {
            reply = await repair(ctx, coder, config, `task:${id}:empty-repair`, `Task ${id} changed no files. Do the work now or cite file:line evidence it is already done.`, "configured build/test gates", "no files changed");
            gate = await runBuildAndTest(ctx);
            if (gate.ok) {
              await recordTaskScopeIssues(input.repo, task, config, issues);
              commit = await commitTask(input.repo, task, issues);
            }
          }

          if (commit.status === "failed") {
            failed.add(id);
            await preserveAndRestoreTaskFailure(ctx, input.repo, task, checkpoint, "commit", commit.log);
            await ctx.observe("task-failed", { task: id, stage: "commit" });
            continue;
          }

          if (commit.status === "nothing" && task.files.length) {
            const recovered = await recoverNoop(ctx, coder, config, input.repo, task, reply);
            reply = recovered.reply;
            noopVerdict = recovered.verdict;
            if (recovered.status === "satisfied") noopTasks.push(id);
            if (recovered.status === "failed") {
              failed.add(id);
              issues.push(recovered.evidence);
              await preserveAndRestoreTaskFailure(ctx, input.repo, task, checkpoint, "noop-recovery", recovered.evidence);
              await ctx.observe("task-failed", { task: id, stage: "noop-recovery" });
            }
          }
          if (!failed.has(id)) await ctx.observe("task-completed", { task: id });
        } catch (error) {
          const evidence = error instanceof Error ? error.message : String(error);
          failed.add(id);
          issues.push(`task ${id} operation failed: ${evidence}`);
          await preserveAndRestoreTaskFailure(ctx, input.repo, task, checkpoint, "operation", evidence);
          await ctx.observe("task-failed", { task: id, stage: "operation" });
        } finally {
          await persistTaskReply(ctx.artifacts.path, task, reply, noopVerdict, issues);
        }
      }
    }
  }

  const finalVerification = await verifyFinalWithRepair(ctx, input.repo, config, baseline, "final-verification");
  if (!finalVerification.ok) {
    issues.push(finalVerification.evidence);
    return { branch, prBody: prBody(issues, true), reviewBlocking: true, issues, failedTasks: [...failed], noopTasks };
  }

  let reviewBlocking = false;
  try {
    const reviewResult = await ctx.run(review, {
      repo: input.repo,
      base: baseBranch,
      autofix: true,
      context: reviewContext(graph, input.instructions),
    });
    issues.push(...reviewResult.issues.map((issue) => `review: ${issue}`));
    const reviewVerification = await verifyFinalWithRepair(ctx, input.repo, config, baseline, "post-review-verification");
    if (!reviewVerification.ok) issues.push(reviewVerification.evidence);
    reviewBlocking = !reviewResult.valid
      || reviewResult.issues.length > 0
      || reviewResult.unresolvedHigh > 0
      || !reviewVerification.ok;
  } catch (error) {
    reviewBlocking = true;
    issues.push(`review failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { branch, prBody: prBody(issues, reviewBlocking), reviewBlocking, issues, failedTasks: [...failed], noopTasks };
});

async function runFinalVerification(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
  baseline: Baseline,
): Promise<VerificationResult> {
  const regression = await compareWithBaseline(ctx, repo, config, baseline);
  const extended = await runGateSet(ctx, ["e2e", "verify"]);
  const gates = [...regression.gates, ...extended.gates];
  const configured = gates.filter((gate) => !gate.result.skipped);
  return {
    ok: configured.length > 0 && configured.every((gate) => gate.result.ok),
    gates,
    evidence: [regression.evidence, extended.evidence].filter(Boolean).join("\n"),
  };
}

async function verifyFinalWithRepair(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
  baseline: Baseline,
  stage: string,
): Promise<{ ok: true } | { ok: false; evidence: string }> {
  const checkpoint = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  let verification = await runFinalVerification(ctx, repo, config, baseline);
  if (verification.ok) {
    const commit = await commitAll(repo, stage === "post-review-verification" ? "review fixes" : `${stage} repair`);
    return commit.status === "failed" ? { ok: false, evidence: commit.log } : { ok: true };
  }

  await using fixer = ctx.agent(config.implement.coder);
  for (let attempt = 1; attempt <= config.implement.repairLimit; attempt++) {
    await ctx.observe("repair-started", { stage, attempt: String(attempt) });
    await repair(
      ctx,
      fixer,
      config,
      `${stage}:repair`,
      "Diagnose whether each failure belongs to product code, test harness, environment, configuration, or dependencies. Fix the root cause without weakening verification.",
      "configured build, test, e2e, and verify gates",
      verification.evidence,
    );
    verification = await runFinalVerification(ctx, repo, config, baseline);
    await ctx.observe("repair-completed", { stage, attempt: String(attempt), outcome: verification.ok ? "passed" : "failed" });
    if (!verification.ok) continue;
    const commit = await commitAll(repo, stage === "post-review-verification" ? "review fixes" : `${stage} repair`);
    return commit.status === "failed" ? { ok: false, evidence: commit.log } : { ok: true };
  }

  await preserveFailedRepair(ctx, repo, stage, verification.evidence);
  await git(repo, ["reset", "--hard", checkpoint]);
  await git(repo, ["clean", "-fd"]);
  return { ok: false, evidence: `${stage} failed: ${verification.evidence}` };
}

async function preserveAndRestoreTaskFailure(
  ctx: SigilContext,
  repo: string,
  task: Task,
  checkpoint: string,
  stage: string,
  evidence: string,
): Promise<void> {
  const diff = await git(repo, ["diff", "--binary", checkpoint, "--"]);
  const name = encodeURIComponent(task.id);
  await ctx.artifacts.write(`failed-tasks/${name}/${stage}.patch`, diff.stdout);
  await ctx.artifacts.write(`failed-tasks/${name}/${stage}.txt`, evidence);
  await git(repo, ["reset", "--hard", checkpoint]);
  await git(repo, ["clean", "-fd"]);
}

async function preserveFailedRepair(ctx: SigilContext, repo: string, stage: string, evidence: string): Promise<void> {
  const diff = await git(repo, ["diff", "--binary", "HEAD", "--"]);
  const name = stage.replace(/[^a-zA-Z0-9._-]+/g, "-");
  await ctx.artifacts.write(`failed-repairs/${name}.patch`, diff.stdout);
  await ctx.artifacts.write(`failed-repairs/${name}.txt`, evidence);
}
