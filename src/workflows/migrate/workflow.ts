import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  promptAgentWithRecovery,
  runFreshAgentOperation,
} from "../../agent-operation.js";
import { loadConfig } from "../../config.js";
import { sigil, type RichSigilAgent, type SigilContext } from "../../context.js";
import { changedPaths, commitAll, git, isCleanTree } from "../../git.js";
import type { WorkflowFailure } from "../../recovery/index.js";
import { runBuildAndTest } from "../../verification.js";
import { refactor, type PathDiscovery, type RefactorResult } from "../refactor/index.js";
import {
  orderMigrationItems,
  parseMigrationBacklog,
  type MigrationBacklog,
  type MigrationItem,
} from "./contracts.js";
import { migrationPrompt } from "./prompts.js";

export type MigrationInput = {
  repo: string;
  targetFile: string;
  backlogFile: string;
  runDir: string;
};

export type MigrationItemResult = {
  id: string;
  status: "completed" | "failed";
  commit?: string;
  refactor?: RefactorResult;
  error?: string;
};

export type MigrationResult = {
  branch: string;
  baseHead: string;
  head: string;
  stateFile: string;
  eventsFile: string;
  architectureReviewFile?: string;
  behaviorReviewFile?: string;
  items: MigrationItemResult[];
  valid: boolean;
  issues: string[];
};

type MigrationState = {
  contractVersion: 1;
  branch: string;
  baseHead: string;
  backlogHash: string;
  targetHash: string;
  completed: Array<{ id: string; commit: string }>;
  discoveries: Record<string, PathDiscovery[]>;
  finalCommits: string[];
  finalVerified: boolean;
};

const ReviewSchema = z.object({
  blocking: z.boolean(),
  findings: z.array(z.object({
    id: z.string().min(1).optional(),
    severity: z.enum(["high", "medium", "low"]),
    evidence: z.string().min(1),
    requiredChange: z.string().min(1),
  })),
});

type MigrationReview = z.infer<typeof ReviewSchema>;

export const migrate = sigil<MigrationInput, MigrationResult>(
  "migrate",
  async (ctx, input) => {
    const paths = await prepareRun(input);
    const target = await readFile(paths.targetFile, "utf8");
    const backlog = parseMigrationBacklog(JSON.parse(await readFile(paths.backlogFile, "utf8")));
    const branch = await requireBranch(input.repo);
    const state = await loadOrCreateState(input, backlog, target, branch, paths.stateFile);
    const items: MigrationItemResult[] = [];

    await recordEvent(paths.eventsFile, "started", { branch });
    await reconcileAndVerifyResumePoint(
      input.repo,
      state,
      backlog,
      paths.itemResultsDir,
      paths.stateFile,
    );

    for (const item of pendingItems(backlog, state)) {
      const result = await runItem(
        ctx,
        input.repo,
        item,
        target,
        paths.eventsFile,
        paths.itemResultsDir,
        backlog.protectedPaths,
        expectedCheckpoint(state),
      );
      items.push(result);
      if (result.status === "failed") {
        return finish(input.repo, state, paths, items, {
          issues: result.refactor?.issues ?? [result.error ?? "migration item failed"],
        });
      }
      state.completed.push({ id: item.id, commit: result.commit! });
      state.discoveries[item.id] = result.refactor?.discoveries ?? [];
      await writeState(paths.stateFile, state);
    }

    const final = await convergeMigration(
      ctx,
      input.repo,
      state,
      backlog,
      target,
      paths,
    );
    state.finalVerified = final.valid;
    await writeState(paths.stateFile, state);
    await recordEvent(paths.eventsFile, final.valid ? "completed" : "failed");
    await ctx.observe(final.valid ? "migration-completed" : "migration-failed", {
      branch: state.branch,
    });
    return finish(input.repo, state, paths, items, final);
  },
);

async function runItem(
  ctx: SigilContext,
  repo: string,
  item: MigrationItem,
  target: string,
  eventsFile: string,
  itemResultsDir: string,
  protectedPaths: string[],
  checkpoint: string,
): Promise<MigrationItemResult> {
  await recordEvent(eventsFile, "item-started", { item: item.id });
  await ctx.observe("migration-item-started", { item: item.id });
  const attemptDir = await nextAttemptDirectory(itemResultsDir, item.id);
  const itemContext = ctx.fork({
    artifactRoot: attemptDir,
    operationPath: `migration/${item.id}/refactor`,
  });
  const input = {
    repo,
    intent: item.intent,
    brief: `${item.brief}\n\nRepository migration target:\n${target}`,
    focus: item.focus,
    protectedPaths,
  };
  await writeJson(join(attemptDir, "input.json"), input);
  let rawResult: RefactorResult;
  try {
    rawResult = await refactor(input, itemContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJson(join(attemptDir, "error.json"), { error: message });
    await persistFailedAttempt(repo, attemptDir, checkpoint, { error: message });
    await restoreCheckpoint(repo, checkpoint);
    await recordEvent(eventsFile, "item-failed", {
      item: item.id,
      stage: "refactor-exception",
    });
    await ctx.observe("migration-item-failed", {
      item: item.id,
      stage: "refactor-exception",
      error: message,
    });
    return { id: item.id, status: "failed", error: message };
  }
  const result = rawResult;
  await writeJson(join(attemptDir, "result.json"), result);
  if (!result.valid) {
    await persistFailedAttempt(repo, attemptDir, checkpoint, { failures: result.failures });
    await restoreCheckpoint(repo, checkpoint);
    await recordEvent(eventsFile, "item-failed", { item: item.id });
    await ctx.observe("migration-item-failed", { item: item.id, stage: "refactor" });
    return { id: item.id, status: "failed", refactor: result };
  }

  await writeJson(join(attemptDir, "checkpoint-pending.json"), {
    item: item.id,
    parent: checkpoint,
    commitMessage: item.commitMessage,
    discoveries: result.discoveries,
  });
  const committed = await commitAll(repo, item.commitMessage);
  if (committed.status !== "committed" || !committed.commit) {
    const error = `migration item ${item.id} could not commit: ${committed.log || committed.status}`;
    await persistFailedAttempt(repo, attemptDir, checkpoint, { error });
    await restoreCheckpoint(repo, checkpoint);
    await recordEvent(eventsFile, "item-failed", { item: item.id, stage: "checkpoint" });
    await ctx.observe("migration-item-failed", {
      item: item.id,
      stage: "checkpoint",
      error,
    });
    return { id: item.id, status: "failed", error };
  }
  await writeJson(join(attemptDir, "checkpoint.json"), {
    item: item.id,
    parent: checkpoint,
    commit: committed.commit,
    discoveries: result.discoveries,
  });
  await recordEvent(eventsFile, "item-completed", { item: item.id, commit: committed.commit });
  await ctx.observe("migration-item-completed", {
    item: item.id,
    commit: committed.commit,
  });
  return { id: item.id, status: "completed", commit: committed.commit, refactor: result };
}

async function reviewMigration(
  ctx: SigilContext,
  repo: string,
  baseHead: string,
  backlog: MigrationBacklog,
  target: string,
  repairLimit: number,
  timeoutMs: number,
  knownFindings: Map<string, number>,
): Promise<{
  architecture?: MigrationReview;
  behavior?: MigrationReview;
  failures: WorkflowFailure[];
}> {
  const diff = await committedDiff(repo, baseHead);
  const reviewer = loadConfig(repo).review.synthesizer;
  const variables = {
    TARGET: target,
    GOAL: backlog.goal,
    DIFF: diff,
    KNOWN_FINDINGS: JSON.stringify([...knownFindings.entries()], null, 2),
  };
  const [architecture, behavior] = await Promise.all([
    runFreshAgentOperation(ctx, reviewer, {
      stage: "migration-review:architecture",
      limit: repairLimit,
      timeoutMs,
    }, (agent) => agent.prompt(
      migrationPrompt("review-architecture", variables),
      ReviewSchema,
    )),
    runFreshAgentOperation(ctx, reviewer, {
      stage: "migration-review:behavior",
      limit: repairLimit,
      timeoutMs,
    }, (agent) => agent.prompt(
      migrationPrompt("review-behavior", variables),
      ReviewSchema,
    )),
  ]);
  const failures = [...architecture.failures, ...behavior.failures];
  if (!architecture.ok || !behavior.ok) {
    if (!architecture.ok) failures.push({ ...architecture.failure, recoverable: false });
    if (!behavior.ok) failures.push({ ...behavior.failure, recoverable: false });
    return { failures };
  }
  return {
    architecture: architecture.value,
    behavior: behavior.value,
    failures,
  };
}

async function loadOrCreateState(
  input: MigrationInput,
  backlog: MigrationBacklog,
  target: string,
  branch: string,
  stateFile: string,
): Promise<MigrationState> {
  const existing = await readOptionalJson<MigrationState>(stateFile);
  const backlogHash = hash(JSON.stringify(backlog));
  const targetHash = hash(target);
  if (existing) {
    if (existing.branch !== branch) throw new Error("migration state belongs to another branch");
    if (existing.backlogHash !== backlogHash) throw new Error("migration backlog changed after execution started");
    if (existing.targetHash !== targetHash) throw new Error("migration target changed after execution started");
    existing.discoveries ??= {};
    existing.finalCommits ??= [];
    existing.finalVerified ??= false;
    return existing;
  }
  if (!(await isCleanTree(input.repo))) throw new Error("working tree is not clean");
  const state: MigrationState = {
    contractVersion: 1,
    branch,
    baseHead: await head(input.repo),
    backlogHash,
    targetHash,
    completed: [],
    discoveries: {},
    finalCommits: [],
    finalVerified: false,
  };
  await writeState(stateFile, state);
  return state;
}

async function reconcileAndVerifyResumePoint(
  repo: string,
  state: MigrationState,
  backlog: MigrationBacklog,
  itemResultsDir: string,
  stateFile: string,
): Promise<void> {
  if (!(await isCleanTree(repo))) throw new Error("working tree is not clean at migration checkpoint");
  const actual = await head(repo);
  if (actual === expectedCheckpoint(state)) return;

  const next = pendingItems(backlog, state)[0];
  const checkpoint = next
    ? await findCheckpoint(repo, itemResultsDir, next.id, actual)
    : undefined;
  if (!checkpoint || checkpoint.parent !== expectedCheckpoint(state)) {
    throw new Error("repository HEAD does not match migration checkpoint");
  }

  state.completed.push({ id: next!.id, commit: checkpoint.commit });
  state.discoveries[next!.id] = checkpoint.discoveries;
  await writeState(stateFile, state);
}

function expectedCheckpoint(state: MigrationState): string {
  return state.finalCommits.at(-1)
    ?? state.completed.at(-1)?.commit
    ?? state.baseHead;
}

async function findCheckpoint(
  repo: string,
  itemResultsDir: string,
  item: string,
  commit: string,
): Promise<{
  item: string;
  parent: string;
  commit: string;
  discoveries: PathDiscovery[];
} | undefined> {
  const itemDir = join(itemResultsDir, item);
  let entries;
  try {
    entries = await readdir(itemDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const attemptDir = join(itemDir, entry.name);
    const checkpoint = await readOptionalJson<{
      item: string;
      parent: string;
      commit: string;
      discoveries: PathDiscovery[];
    }>(join(attemptDir, "checkpoint.json"));
    if (checkpoint?.item === item && checkpoint.commit === commit) return checkpoint;

    const pending = await readOptionalJson<{
      item: string;
      parent: string;
      commitMessage: string;
      discoveries: PathDiscovery[];
    }>(join(attemptDir, "checkpoint-pending.json"));
    if (pending?.item !== item) continue;
    const parent = await git(repo, ["rev-parse", `${commit}^`]);
    const subject = await git(repo, ["log", "-1", "--format=%s", commit]);
    if (parent.code !== 0 || subject.code !== 0) continue;
    if (parent.stdout.trim() !== pending.parent) continue;
    if (subject.stdout.trim() !== pending.commitMessage) continue;
    return {
      item,
      parent: pending.parent,
      commit,
      discoveries: pending.discoveries,
    };
  }
  return undefined;
}

function pendingItems(backlog: MigrationBacklog, state: MigrationState): MigrationItem[] {
  const completed = new Set(state.completed.map((item) => item.id));
  return orderMigrationItems(backlog.items).filter((item) => !completed.has(item.id));
}

async function prepareRun(input: MigrationInput): Promise<{
  targetFile: string;
  backlogFile: string;
  stateFile: string;
  eventsFile: string;
  itemResultsDir: string;
  finalDir: string;
}> {
  const runDir = resolve(input.runDir);
  requireExternalRunDirectory(input.repo, runDir);
  const itemResultsDir = join(runDir, "items");
  const finalDir = join(runDir, "final");
  await mkdir(itemResultsDir, { recursive: true });
  await mkdir(finalDir, { recursive: true });
  return {
    targetFile: resolve(input.targetFile),
    backlogFile: resolve(input.backlogFile),
    stateFile: join(runDir, "state.json"),
    eventsFile: join(runDir, "events.jsonl"),
    itemResultsDir,
    finalDir,
  };
}

function requireExternalRunDirectory(repo: string, runDir: string): void {
  const path = relative(resolve(repo), runDir);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    throw new Error("migration run directory must be outside the target repository");
  }
}

async function nextAttemptDirectory(root: string, item: string): Promise<string> {
  const itemDir = join(root, item);
  await mkdir(itemDir, { recursive: true });
  const entries = await readdir(itemDir, { withFileTypes: true });
  const attempts = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^attempt-(\d+)$/.exec(entry.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  const next = Math.max(0, ...attempts) + 1;
  const attemptDir = join(itemDir, `attempt-${next}`);
  await mkdir(attemptDir, { recursive: true });
  return attemptDir;
}

async function persistFailedAttempt(
  repo: string,
  attemptDir: string,
  checkpoint: string,
  failure: unknown,
): Promise<void> {
  const diff = await git(repo, ["diff", "--binary", "--no-ext-diff", checkpoint, "--"]);
  const status = await git(repo, ["status", "--short", "--branch"]);
  if (diff.code !== 0) throw new Error(diff.log || "failed to preserve migration diff");
  if (status.code !== 0) throw new Error(status.log || "failed to preserve migration status");
  await writeFile(join(attemptDir, "diff.patch"), diff.stdout);
  await writeFile(join(attemptDir, "status.txt"), status.stdout);
  await writeJson(join(attemptDir, "failure.json"), failure);
}

async function restoreCheckpoint(repo: string, checkpoint: string): Promise<void> {
  const reset = await git(repo, ["reset", "--hard", checkpoint]);
  if (reset.code !== 0) throw new Error(reset.log || "failed to restore migration checkpoint");
  const clean = await git(repo, ["clean", "-fd"]);
  if (clean.code !== 0) throw new Error(clean.log || "failed to clean failed migration attempt");
}

async function finish(
  repo: string,
  state: MigrationState,
  paths: { stateFile: string; eventsFile: string },
  items: MigrationItemResult[],
  reviews: {
    architectureReviewFile?: string;
    behaviorReviewFile?: string;
    valid?: boolean;
    issues?: string[];
  } = {},
): Promise<MigrationResult> {
  return {
    branch: state.branch,
    baseHead: state.baseHead,
    head: await head(repo),
    stateFile: paths.stateFile,
    eventsFile: paths.eventsFile,
    ...reviews,
    items,
    valid: reviews.valid ?? false,
    issues: reviews.issues ?? [],
  };
}

async function convergeMigration(
  ctx: SigilContext,
  repo: string,
  state: MigrationState,
  backlog: MigrationBacklog,
  target: string,
  paths: {
    stateFile: string;
    eventsFile: string;
    finalDir: string;
  },
): Promise<{
  architectureReviewFile?: string;
  behaviorReviewFile?: string;
  valid: boolean;
  issues: string[];
}> {
  const config = loadConfig(repo);
  let architectureReviewFile: string | undefined;
  let behaviorReviewFile: string | undefined;
  const findingAttempts = new Map<string, number>();
  let round = 0;

  await using repairer = ctx.agent(config.implement.coder);
  while (true) {
    round++;
    await recordEvent(paths.eventsFile, "final-verification-started", {
      round: String(round),
    });
    const verification = await runBuildAndTest(ctx);
    const reviews = await reviewMigration(
      ctx,
      repo,
      state.baseHead,
      backlog,
      target,
      config.implement.repairLimit,
      config.implement.operationTimeoutMs,
      findingAttempts,
    );
    if (!reviews.architecture || !reviews.behavior) {
      return {
        architectureReviewFile,
        behaviorReviewFile,
        valid: false,
        issues: reviews.failures.filter((failure) => !failure.recoverable)
          .map((failure) => failure.evidence),
      };
    }
    architectureReviewFile = await writeJson(
      join(paths.finalDir, `round-${round}-architecture-review.json`),
      reviews.architecture,
    );
    behaviorReviewFile = await writeJson(
      join(paths.finalDir, `round-${round}-behavior-review.json`),
      reviews.behavior,
    );
    if (verification.ok && !reviews.architecture.blocking && !reviews.behavior.blocking) {
      await recordEvent(paths.eventsFile, "final-verification-completed", {
        round: String(round),
      });
      return { architectureReviewFile, behaviorReviewFile, valid: true, issues: [] };
    }

    const findings = migrationFindings(verification, reviews.architecture, reviews.behavior);
    const exhausted = findings.filter((finding) =>
      (findingAttempts.get(finding.key) ?? 0) >= config.implement.repairLimit
    );
    if (exhausted.length) {
      return {
        architectureReviewFile,
        behaviorReviewFile,
        valid: false,
        issues: exhausted.map((finding) => finding.evidence),
      };
    }
    for (const finding of findings) {
      findingAttempts.set(finding.key, (findingAttempts.get(finding.key) ?? 0) + 1);
    }

    const evidence = JSON.stringify({
      verification: verification.evidence,
      architecture: reviews.architecture,
      behavior: reviews.behavior,
      repairHistory: [...findingAttempts.entries()],
    }, null, 2);

    await recordEvent(paths.eventsFile, "final-repair-started", {
      round: String(round),
    });
    const repair = await promptAgentWithRecovery(
      ctx,
      repairer,
      migrationPrompt("repair-final", {
        TARGET: target,
        GOAL: backlog.goal,
        EVIDENCE: evidence,
      }),
      {
        stage: `migration-final:repair:${round}`,
        limit: config.implement.repairLimit,
        timeoutMs: config.implement.operationTimeoutMs,
      },
    );
    if (!repair.ok) {
      return {
        architectureReviewFile,
        behaviorReviewFile,
        valid: false,
        issues: [repair.failure.evidence],
      };
    }

    const authority = await repairMigrationProtectedPaths(
      ctx,
      repairer,
      repo,
      target,
      backlog.protectedPaths,
      config.implement.repairLimit,
      config.implement.operationTimeoutMs,
    );
    if (!authority.ok) {
      return {
        architectureReviewFile,
        behaviorReviewFile,
        valid: false,
        issues: [authority.evidence],
      };
    }

    const commit = await commitAll(repo, "Repair repository migration verification");
    if (commit.status === "failed") {
      return {
        architectureReviewFile,
        behaviorReviewFile,
        valid: false,
        issues: [`final repair commit failed: ${commit.log}`],
      };
    }
    if (commit.commit) {
      state.finalCommits.push(commit.commit);
      await writeState(paths.stateFile, state);
    }
    await recordEvent(paths.eventsFile, "final-repair-completed", {
      round: String(round),
      commit: commit.commit ?? "no-change",
    });
  }
}

type MigrationFinding = { key: string; evidence: string };

function migrationFindings(
  verification: Awaited<ReturnType<typeof runBuildAndTest>>,
  architecture: MigrationReview,
  behavior: MigrationReview,
): MigrationFinding[] {
  const findings = [
    ...(architecture.blocking ? architecture.findings : []),
    ...(behavior.blocking ? behavior.findings : []),
  ].map((finding) => ({
    key: migrationReviewFindingKey(finding),
    evidence: JSON.stringify(finding),
  }));
  if (!verification.ok) {
    const failed = verification.gates
      .filter((gate) => !gate.result.skipped && !gate.result.ok)
      .map((gate) => gate.name)
      .join(",");
    findings.push({ key: `gate:${failed}`, evidence: verification.evidence });
  }
  return findings;
}

function migrationReviewFindingKey(
  finding: MigrationReview["findings"][number],
): string {
  if (finding.id) return `review:${finding.id.toLowerCase().replace(/\s+/g, "-")}`;
  return [finding.severity, finding.evidence, finding.requiredChange]
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function repairMigrationProtectedPaths(
  ctx: SigilContext,
  repairer: RichSigilAgent,
  repo: string,
  target: string,
  protectedPaths: string[],
  repairLimit: number,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; evidence: string }> {
  for (let attempt = 1; attempt <= repairLimit + 1; attempt++) {
    const changed = await changedProtectedPaths(repo, protectedPaths);
    if (!changed.length) return { ok: true };
    if (attempt > repairLimit) {
      return { ok: false, evidence: `final repair changed protected paths: ${changed.join(", ")}` };
    }
    const repair = await promptAgentWithRecovery(
      ctx,
      repairer,
      migrationPrompt("repair-protected-paths", {
        TARGET: target,
        PROTECTED_PATHS: protectedPaths.join("\n"),
        CHANGED_PATHS: changed.join("\n"),
      }),
      {
        stage: "migration-final:authority-repair",
        limit: repairLimit,
        timeoutMs,
      },
    );
    if (!repair.ok) return { ok: false, evidence: repair.failure.evidence };
  }
  return { ok: false, evidence: "protected path recovery exhausted" };
}

async function changedProtectedPaths(repo: string, protectedPaths: string[]): Promise<string[]> {
  const changed = await changedPaths(repo);
  const roots = protectedPaths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""));
  return changed.filter((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)));
}

async function committedDiff(repo: string, baseHead: string): Promise<string> {
  const result = await git(repo, ["diff", "--no-ext-diff", `${baseHead}..HEAD`, "--"]);
  if (result.code !== 0) throw new Error(result.log || "failed to read migration diff");
  return result.stdout;
}

async function requireBranch(repo: string): Promise<string> {
  const result = await git(repo, ["branch", "--show-current"]);
  const branch = result.stdout.trim();
  if (result.code !== 0 || !branch) throw new Error("migration requires a named branch");
  return branch;
}

async function head(repo: string): Promise<string> {
  const result = await git(repo, ["rev-parse", "HEAD"]);
  if (result.code !== 0) throw new Error(result.log || "failed to read repository HEAD");
  return result.stdout.trim();
}

async function writeState(path: string, state: MigrationState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function recordEvent(
  path: string,
  stage: string,
  details: Record<string, string> = {},
): Promise<void> {
  await appendFile(path, `${JSON.stringify({
    at: new Date().toISOString(),
    stage,
    ...details,
  })}\n`);
  const suffix = Object.values(details).length ? ` ${Object.values(details).join(" ")}` : "";
  process.stderr.write(`[migrate] ${stage}${suffix}\n`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
