import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { promptAgentTurn, runFreshAgentOperation } from "../../../agent-operation.js";
import { loadConfig, type SigilConfig } from "../../../config.js";
import { taskGraphDigest, validateTaskGraph, type Task, type TaskGraph } from "../../../contracts/task-graph.js";
import { changedPaths, checkoutFreshBranch, commitAll, git, isCleanTree, repositoryPathsDigest, type CommitResult } from "../../../git.js";
import { sigil, type RichSigilAgent, type SigilContext } from "../../../context.js";
import { implementationPrompts } from "./prompts.js";
import { CoderSessionLifecycle } from "./coder-session.js";
import {
  compareResultWithBaseline,
  clearTestReport,
  establishBaseline,
  refreshVerificationReceipt,
  restoreBaseline,
  runTaskVerification,
  serializeBaseline,
  runGateSet,
  runBuildAndTest,
  verificationMatchesCurrentState,
  type Baseline,
  type VerificationResult,
} from "../../../verification.js";
import { review } from "../review/index.js";
import { bootstrapWorkspace } from "../../../workspace.js";
import type { WorkflowFailure } from "../../../recovery/index.js";
import {
  captureRecoveryBundle,
  discardTaskWork,
  newCheckpoint,
  nextRunnable,
  readCheckpoint,
  reevaluateBlocked,
  restoreRecoveryBundle,
  verifyCompletedTasks,
  writeAtomicJson,
  type ImplementationCheckpoint,
} from "./checkpoint.js";

export type ImplementInput = {
  taskFile: string;
  repo: string;
  branch?: string;
  baseBranch?: string;
  brief?: string;
  instructions?: string;
  canonicalGraphFile?: string;
  checkpointFile?: string;
  resume?: boolean;
};
export type ImplementResult = { branch: string; prBody: string; reviewBlocking: boolean; issues: string[]; failedTasks: string[]; noopTasks: string[] };

type ArtifactPath = (name: string) => string;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function taskPrompt(task: Task): string {
  return implementationPrompts.task({
    TASK_ID: task.id,
    TASK_TITLE: task.title,
    TASK_SUMMARY: task.summary,
    DEPENDENCIES: task.dependencies.map((dependency) => `- ${dependency}`).join("\n") || "- none",
    ACCEPTANCE: task.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    INTERFACES: [
      "Produces:",
      ...task.interfaces.produces.map((output) => `- ${output.name}: ${output.description}`),
      "Consumes:",
      ...task.interfaces.consumes.map((input) => `- ${input.taskId}.${input.name}: ${input.description}`),
    ].join("\n"),
    VERIFICATION: task.verification.map((check) => check.kind === "command"
      ? `- command: ${check.command}\n  expected: ${check.expected}`
      : `- manual: ${check.procedure}\n  expected: ${check.expected}\n  rationale: ${check.rationale}`).join("\n"),
    DIAGRAMS: task.diagrams.join("\n") || "- none",
    FILES: task.files.map((f) => `- ${f.action} ${f.path}\n${f.details.map((d) => `  - ${d}`).join("\n")}`).join("\n"),
  });
}

function coderSessionHandoff(
  graph: TaskGraph,
  checkpoint: ImplementationCheckpoint,
  branch: string,
  head: string,
): string {
  const completed = Object.entries(checkpoint.tasks)
    .filter(([, state]) => state.status === "completed")
    .map(([id, state]) => {
      const task = graph.tasks.find((candidate) => candidate.id === id);
      const outputs = task?.interfaces.produces.map((output) => output.name).join(", ") || "none";
      return `- ${id}: ${state.verifiedCommit ?? "verified commit unavailable"}; produced interfaces: ${outputs}`;
    });
  if (!completed.length) return "";

  return implementationPrompts.sessionHandoff({
    GOAL: graph.goal,
    GRAPH_DIGEST: checkpoint.graphDigest,
    BRANCH: branch,
    HEAD: head,
    COMPLETED_TASKS: completed.join("\n"),
  });
}

type SessionContextInput = {
  config: SigilConfig;
  graph: TaskGraph;
  checkpoint: ImplementationCheckpoint;
  branch: string;
  head: string;
  brief?: string;
  instructions?: string;
};

async function sessionContextPrompt(
  ctx: SigilContext,
  input: SessionContextInput,
): Promise<string> {
  const configuredContext = await ctx.renderContextBlock(input.config.context);
  const context = implementationContextBlock(configuredContext, input.instructions);
  const handoff = coderSessionHandoff(input.graph, input.checkpoint, input.branch, input.head);

  return implementationPrompts.sessionContext({
    PREAMBLE: implementationPrompts.preamble(),
    GOAL: input.graph.goal,
    ARCHITECTURE: input.graph.architecture,
    CONSTRAINTS: input.graph.constraints.map((constraint) => `- ${constraint}`).join("\n") || "- none",
    NON_GOALS: input.graph.nonGoals.map((nonGoal) => `- ${nonGoal}`).join("\n") || "- none",
    CONFIRMED_BRIEF: input.brief?.trim() || "No confirmed brief was supplied for this standalone task graph.",
    CONTEXT: context,
    HANDOFF: handoff,
  });
}

async function coderSessionInitializationPrompt(
  ctx: SigilContext,
  input: SessionContextInput,
): Promise<string> {
  const context = await sessionContextPrompt(ctx, input);
  return [context, implementationPrompts.taskInstructions()].join("\n\n");
}

function taskTurnPrompt(initialization: string, task: Task): string {
  return [initialization, taskPrompt(task)].filter(Boolean).join("\n\n");
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

function reviewTaskContract(task: Task): string {
  return [
    `### ${task.id}: ${task.title}`,
    "",
    task.summary,
    "",
    "Acceptance criteria:",
    task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
    "",
    "Produces:",
    task.interfaces.produces.map((output) => `- ${output.name}: ${output.description}`).join("\n") || "- none",
    "",
    "Consumes:",
    task.interfaces.consumes.map((input) => `- ${input.taskId}.${input.name}: ${input.description}`).join("\n") || "- none",
  ].join("\n");
}

function reviewContext(
  graph: TaskGraph,
  brief: string | undefined,
  instructions: string | undefined,
): string {
  return [
    "# Confirmed change contract",
    "",
    "Preserve confirmed intent, acceptance criteria, decisions, architecture, constraints, and non-goals. Verify repository descriptions, current-behavior claims, affected-file expectations, and proposed mechanisms against current source and observed behavior. Report conflicts instead of silently changing a confirmed requirement.",
    "",
    "## Confirmed brief",
    brief?.trim() || "No confirmed brief was supplied for this standalone task graph.",
    "",
    "## Goal",
    graph.goal,
    "",
    "## Architecture",
    graph.architecture,
    "",
    "## Constraints",
    graph.constraints.map((constraint) => `- ${constraint}`).join("\n") || "- none",
    "",
    "## Non-goals",
    graph.nonGoals.map((nonGoal) => `- ${nonGoal}`).join("\n") || "- none",
    "",
    "## Acceptance criteria and interfaces",
    graph.tasks.map(reviewTaskContract).join("\n\n"),
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
  const result = await promptAgentTurn(ctx, agent, prompt, {
    stage,
    limit: config.implement.repairLimit,
    timeoutMs: config.implement.operationTimeoutMs,
        idleTimeoutMs: config.implement.idleTimeoutMs,
  });
  if (!result.ok) throw new AgentOperationFailure(result.failure);
  return result.value;
}

class AgentOperationFailure extends Error {
  constructor(readonly failure: WorkflowFailure) {
    super(failure.evidence);
    this.name = "AgentOperationFailure";
  }
}

function providerInterrupted(error: unknown): error is AgentOperationFailure {
  return error instanceof AgentOperationFailure
    && error.failure.provider !== undefined
    && error.failure.provider.disposition !== "terminal";
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
  return result;
}

async function runTaskGates(ctx: SigilContext, task: Task): Promise<VerificationResult> {
  const focused = await runTaskVerification(ctx, task);
  if (focused.gates.length && !focused.ok) return focused;

  const global = await runBuildAndTest(ctx);
  return {
    ok: global.ok,
    gates: [...focused.gates, ...global.gates],
    evidence: [focused.evidence, global.evidence].filter(Boolean).join("\n"),
  };
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
        idleTimeoutMs: config.implement.idleTimeoutMs,
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
    const gate = await runTaskGates(ctx, task);
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
  const baseBranch = input.baseBranch ?? config.implement.baseBranch;
  const canonicalGraphFile = input.canonicalGraphFile ?? ctx.artifacts.path("implementation/task-graph.json");
  const checkpointFile = input.checkpointFile ?? ctx.artifacts.path("implementation/checkpoint.json");
  let graph: TaskGraph;
  let checkpoint: ImplementationCheckpoint;
  let baseline: Baseline;
  let branch: string;

  if (input.resume) {
    graph = validateTaskGraph(await readJson(canonicalGraphFile), { repoRoot: input.repo });
    checkpoint = await readCheckpoint(checkpointFile);
    const digest = taskGraphDigest(graph);
    if (checkpoint.graphDigest !== digest) throw new Error("canonical task graph digest does not match implementation checkpoint");
    branch = checkpoint.branch;
    if (checkpoint.baseBranch !== baseBranch) throw new Error("implementation checkpoint base branch does not match resume input");
    const currentBranch = (await git(input.repo, ["branch", "--show-current"])).stdout.trim();
    if (currentBranch !== branch) throw new Error(`implementation checkpoint branch mismatch: expected ${branch}, found ${currentBranch}`);
    await verifyCompletedTasks(input.repo, checkpoint);
    baseline = restoreBaseline(checkpoint.baseline);
    const running = Object.entries(checkpoint.tasks).find(([, state]) => state.recoveryBundle !== undefined);
    if (running) {
      const [taskId, state] = running;
      if (!state.recoveryBundle || !state.taskBase) throw new Error(`running task ${taskId} has no recovery bundle`);
      try {
        await restoreRecoveryBundle(input.repo, state.recoveryBundle, {
          graphDigest: checkpoint.graphDigest, branch, baseBranch, baselineCommit: checkpoint.baselineCommit,
          taskId, taskBase: state.taskBase,
        });
      } catch (error) {
        throw new Error(`implementation recovery reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      state.status = "pending";
      await writeAtomicJson(checkpointFile, checkpoint);
    } else if (!(await isCleanTree(input.repo))) {
      throw new Error("resume worktree is dirty without a matching recovery bundle");
    }
  } else {
    graph = validateTaskGraph(await readJson(input.taskFile), { repoRoot: input.repo });
    await writeAtomicJson(canonicalGraphFile, graph);
    if (!(await isCleanTree(input.repo))) throw new Error("working tree is not clean");
    branch = branchName(config, input, graph);
    await checkoutFreshBranch(input.repo, branch, baseBranch);
    await bootstrapWorkspace(ctx, input.repo, config);
    const baselineSha = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
    if (!baselineSha) throw new Error("failed to record baseline sha");
    const baselineResult = await establishBaseline(ctx, input.repo, config);
    if ("kind" in baselineResult) {
      const issues = [`baseline could not be established: ${baselineResult.evidence}`];
      return { branch, prBody: prBody(issues, true), reviewBlocking: true, issues, failedTasks: graph.tasks.map((task) => task.id), noopTasks: [] };
    }
    baseline = baselineResult;
    checkpoint = newCheckpoint(
      graph,
      taskGraphDigest(graph),
      branch,
      baseBranch,
      baselineSha,
      serializeBaseline(baseline),
    );
    await writeAtomicJson(checkpointFile, checkpoint);
  }

  const byId = Object.fromEntries(graph.tasks.map((task) => [task.id, task]));
  const issues: string[] = [];
  const noopTasks: string[] = [];
  let interrupted = false;
  await using coderSessions = new CoderSessionLifecycle(
    ctx,
    config.implement.coder,
    config.implement.sessionTaskLimit,
  );

  for (;;) {
    const id = nextRunnable(graph, checkpoint);
    if (!id) break;
    const task = byId[id];
    const state = checkpoint.tasks[id];
    const taskStarted = performance.now();
    const taskBase = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
    state.status = "running";
    state.attempts++;
    state.taskBase = taskBase;
    state.evidence = undefined;
    state.recoveryBundle = undefined;
    await writeAtomicJson(checkpointFile, checkpoint);
    await ctx.observe("task-started", { task: id });
    let reply = "";
    let noopVerdict: string | undefined;
    const session = await coderSessions.acquire();
    const coder = session.agent;
    const initialization = session.newSession
      ? await coderSessionInitializationPrompt(ctx, {
          config,
          graph,
          checkpoint,
          branch,
          head: taskBase,
          brief: input.brief,
          instructions: input.instructions,
        })
      : "";
    const prompt = taskTurnPrompt(initialization, task);
    await ctx.observe("coder-prompt-prepared", {
      task: id,
      kind: session.newSession ? "session-task" : "task",
      characters: String(prompt.length),
    });

    try {
      reply = await promptWithRecovery(
        ctx,
        coder,
        config,
        `task:${id}:implement`,
        prompt,
      );
      let gate = await runTaskGates(ctx, task);
      for (let attempt = 0; !gate.ok && attempt < config.implement.repairLimit; attempt++) {
        reply = await repair(
          ctx,
          coder,
          config,
          `task:${id}:gate-repair`,
          `Task ${id} failed focused verification or repository gates. Follow relevant repository dependencies while preserving task intent.`,
          "focused task verification and configured build/test gates",
          gate.evidence,
        );
        gate = await runTaskGates(ctx, task);
      }
      if (!gate.ok) {
        state.status = "failed";
        state.evidence = gate.evidence;
        issues.push(`task ${id} failed gates: ${gate.evidence}`);
        await preserveAndRestoreTaskFailure(ctx, input.repo, task, taskBase, "build-test", gate.evidence);
        await writeAtomicJson(checkpointFile, checkpoint);
        await ctx.observe("task-failed", { task: id, stage: "build-test" });
        await coderSessions.invalidate("task-gates-exhausted");
        continue;
      }

      await recordTaskScopeIssues(input.repo, task, config, issues);
      let commit = await commitTask(input.repo, task, issues);
      if (commit.status === "nothing" && task.files.length) {
        reply = await repair(ctx, coder, config, `task:${id}:empty-repair`, `Task ${id} changed no files. Do the work now or cite file:line evidence it is already done.`, "configured build/test gates", "no files changed");
        gate = await runTaskGates(ctx, task);
        if (gate.ok) {
          await recordTaskScopeIssues(input.repo, task, config, issues);
          commit = await commitTask(input.repo, task, issues);
        }
      }

      if (commit.status === "failed") {
        state.status = "failed";
        state.evidence = commit.log;
        await preserveAndRestoreTaskFailure(ctx, input.repo, task, taskBase, "commit", commit.log);
        await writeAtomicJson(checkpointFile, checkpoint);
        await ctx.observe("task-failed", { task: id, stage: "commit" });
        await coderSessions.invalidate("task-commit-failed");
        continue;
      }

      if (commit.status === "nothing" && task.files.length) {
        const recovered = await recoverNoop(ctx, coder, config, input.repo, task, reply);
        reply = recovered.reply;
        noopVerdict = recovered.verdict;
        if (recovered.status === "satisfied") noopTasks.push(id);
        if (recovered.status === "failed") {
          state.status = "failed";
          state.evidence = recovered.evidence;
          issues.push(recovered.evidence);
          await preserveAndRestoreTaskFailure(ctx, input.repo, task, taskBase, "noop-recovery", recovered.evidence);
          await ctx.observe("task-failed", { task: id, stage: "noop-recovery" });
          await coderSessions.invalidate("task-noop-recovery-exhausted");
        }
      }
      if (state.status !== "failed") {
        state.status = "completed";
        state.verifiedCommit = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
        await writeAtomicJson(checkpointFile, checkpoint);
        await ctx.observe("task-completed", { task: id });
      }
    } catch (error) {
      const evidence = error instanceof Error ? error.message : String(error);
      if (providerInterrupted(error)) {
        try {
          state.recoveryBundle = await captureRecoveryBundle(input.repo, ctx.artifacts.path(`implementation/recovery/${encodeURIComponent(id)}`), {
            graphDigest: checkpoint.graphDigest, branch, baseBranch, baselineCommit: checkpoint.baselineCommit, taskId: id, taskBase,
          });
          state.status = "pending";
          if (error.failure.provider?.code === "capacity_exhausted") {
            state.attempts = Math.max(0, state.attempts - 1);
          }
          state.evidence = evidence;
          await discardTaskWork(input.repo, taskBase);
          await writeAtomicJson(checkpointFile, checkpoint);
          interrupted = true;
          await ctx.observe("task-interrupted", { task: id, stage: "provider" });
        } catch (bundleError) {
          state.status = "failed";
          state.evidence = `provider interruption recovery capture failed: ${bundleError instanceof Error ? bundleError.message : String(bundleError)}`;
          issues.push(`task ${id} ${state.evidence}`);
          await writeAtomicJson(checkpointFile, checkpoint);
        }
        await coderSessions.invalidate("provider-interrupted");
      } else {
        state.status = "failed";
        state.evidence = evidence;
        issues.push(`task ${id} operation failed: ${evidence}`);
        await preserveAndRestoreTaskFailure(ctx, input.repo, task, taskBase, "operation", evidence);
        await writeAtomicJson(checkpointFile, checkpoint);
        await ctx.observe("task-failed", { task: id, stage: "operation" });
        await coderSessions.invalidate("task-operation-failed");
      }
    } finally {
      await persistTaskReply(ctx.artifacts.path, task, reply, noopVerdict, issues);
      await ctx.observe("task-finished", {
        task: id,
        outcome: state.status,
        durationMs: String(Math.round(performance.now() - taskStarted)),
      });
    }
    if (interrupted) break;
  }

  reevaluateBlocked(graph, checkpoint);
  await writeAtomicJson(checkpointFile, checkpoint);
  const incomplete = Object.values(checkpoint.tasks).some((state) => state.status !== "completed");
  const failedTasks = Object.entries(checkpoint.tasks).filter(([, state]) => state.status === "failed").map(([id]) => id);
  if (incomplete) {
    const blocked = Object.entries(checkpoint.tasks).filter(([, state]) => state.status === "blocked").map(([id]) => id);
    if (blocked.length) issues.push(`blocked tasks awaiting completed dependencies: ${blocked.join(", ")}`);
    if (interrupted) issues.push("implementation stopped after provider interruption; resume with the implementation checkpoint");
    return { branch, prBody: prBody(issues, true), reviewBlocking: true, issues, failedTasks, noopTasks };
  }

  const finalVerification = await verifyFinalWithRepair(ctx, {
    repo: input.repo,
    config,
    baseline,
    stage: "final-verification",
    graph,
    checkpoint,
    branch,
    brief: input.brief,
    instructions: input.instructions,
  });
  if (!finalVerification.ok) {
    issues.push(finalVerification.evidence);
    return { branch, prBody: prBody(issues, true), reviewBlocking: true, issues, failedTasks, noopTasks };
  }

  let reviewBlocking = false;
  try {
    const reviewResult = await ctx.run(review, {
      repo: input.repo,
      base: baseBranch,
      autofix: true,
      context: reviewContext(graph, input.brief, input.instructions),
    });
    issues.push(...reviewResult.issues.map((issue) => `review: ${issue}`));
    const reviewVerification = await verifyFinalWithRepair(ctx, {
      repo: input.repo,
      config,
      baseline,
      stage: "post-review-verification",
      graph,
      checkpoint,
      branch,
      brief: input.brief,
      instructions: input.instructions,
      candidate: reviewResult.verification ?? finalVerification.verification,
    });
    if (!reviewVerification.ok) issues.push(reviewVerification.evidence);
    reviewBlocking = !reviewResult.valid
      || reviewResult.issues.length > 0
      || reviewResult.unresolvedHigh > 0
      || !reviewVerification.ok;
  } catch (error) {
    reviewBlocking = true;
    issues.push(`review failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { branch, prBody: prBody(issues, reviewBlocking), reviewBlocking, issues, failedTasks, noopTasks };
});

async function runFinalVerification(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
  baseline: Baseline,
): Promise<VerificationResult> {
  await clearTestReport(config, repo);
  const current = await runGateSet(ctx, FINAL_VERIFICATION_GATES);
  return compareResultWithBaseline(repo, config, baseline, current);
}

const FINAL_VERIFICATION_GATES = ["build", "test", "e2e", "verify"] as const;

type FinalVerificationRepairInput = {
  repo: string;
  config: SigilConfig;
  baseline: Baseline;
  stage: string;
  graph: TaskGraph;
  checkpoint: ImplementationCheckpoint;
  branch: string;
  brief?: string;
  instructions?: string;
  candidate?: VerificationResult;
};

async function verifyFinalWithRepair(
  ctx: SigilContext,
  input: FinalVerificationRepairInput,
): Promise<{ ok: true; verification: VerificationResult } | { ok: false; evidence: string }> {
  const repairBase = (await git(input.repo, ["rev-parse", "HEAD"])).stdout.trim();
  let verification = input.candidate?.ok
    && await verificationMatchesCurrentState(ctx, input.candidate, FINAL_VERIFICATION_GATES)
    ? input.candidate
    : await runFinalVerification(ctx, input.repo, input.config, input.baseline);
  if (verification.ok) {
    return commitVerifiedResult(ctx, input, verification);
  }

  const initialization = await sessionContextPrompt(ctx, {
    config: input.config,
    graph: input.graph,
    checkpoint: input.checkpoint,
    branch: input.branch,
    head: repairBase,
    brief: input.brief,
    instructions: input.instructions,
  });
  await using fixer = ctx.agent(input.config.implement.coder);
  for (let attempt = 1; attempt <= input.config.implement.repairLimit; attempt++) {
    const repairContext = [
      attempt === 1 ? initialization : "",
      "Diagnose whether each failure belongs to product code, test harness, environment, configuration, or dependencies. Fix the root cause without weakening verification.",
    ].filter(Boolean).join("\n\n");
    await ctx.observe("repair-started", { stage: input.stage, attempt: String(attempt) });
    await repair(
      ctx,
      fixer,
      input.config,
      `${input.stage}:repair`,
      repairContext,
      "configured build, test, e2e, and verify gates",
      verification.evidence,
    );
    verification = await runFinalVerification(ctx, input.repo, input.config, input.baseline);
    await ctx.observe("repair-completed", {
      stage: input.stage,
      attempt: String(attempt),
      outcome: verification.ok ? "passed" : "failed",
    });
    if (!verification.ok) continue;
    return commitVerifiedResult(ctx, input, verification);
  }

  await preserveFailedRepair(ctx, input.repo, input.stage, verification.evidence);
  await git(input.repo, ["reset", "--hard", repairBase]);
  await git(input.repo, ["clean", "-fd"]);
  return { ok: false, evidence: `${input.stage} failed: ${verification.evidence}` };
}

async function commitVerifiedResult(
  ctx: SigilContext,
  input: FinalVerificationRepairInput,
  verification: VerificationResult,
): Promise<{ ok: true; verification: VerificationResult } | { ok: false; evidence: string }> {
  const paths = await changedPaths(input.repo);
  if (!paths.length) {
    return {
      ok: true,
      verification: await refreshVerificationReceipt(ctx, verification, FINAL_VERIFICATION_GATES),
    };
  }

  const before = await repositoryPathsDigest(input.repo, paths);
  const commit = await commitAll(
    input.repo,
    input.stage === "post-review-verification" ? "review fixes" : `${input.stage} repair`,
  );
  if (commit.status === "failed") return { ok: false, evidence: commit.log };

  const committedPaths = (await git(input.repo, ["diff-tree", "--no-commit-id", "--name-only", "--find-renames", "--find-copies", "-r", "HEAD^", "HEAD"])).stdout
    .split("\n")
    .filter(Boolean)
    .sort();
  const after = await repositoryPathsDigest(input.repo, paths);
  if (before !== after || committedPaths.join("\0") !== [...paths].sort().join("\0") || !(await isCleanTree(input.repo))) {
    return { ok: false, evidence: `${input.stage} commit changed the verified repository contents` };
  }
  return {
    ok: true,
    verification: await refreshVerificationReceipt(ctx, verification, FINAL_VERIFICATION_GATES),
  };
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
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean).sort();
  const archive: Array<{ path: string; data: string }> = [];
  let archiveBytes = 0;
  for (const path of untracked) {
    const data = await readFile(join(repo, path));
    archiveBytes += data.byteLength;
    if (archiveBytes > 10 * 1024 * 1024) {
      await ctx.artifacts.write(`failed-tasks/${encodeURIComponent(task.id)}/${stage}-untracked.txt`, "untracked evidence exceeded 10 MiB and was not deleted");
      throw new Error(`task ${task.id} untracked failure evidence exceeds 10 MiB; worktree preserved for reconciliation`);
    }
    archive.push({ path, data: data.toString("base64") });
  }
  const name = encodeURIComponent(task.id);
  await ctx.artifacts.write(`failed-tasks/${name}/${stage}.patch`, diff.stdout);
  await ctx.artifacts.write(`failed-tasks/${name}/${stage}-untracked.json`, JSON.stringify(archive));
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
