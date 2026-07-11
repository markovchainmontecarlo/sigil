import { execFile } from "node:child_process";
import { extractFailureLog } from "./reports/failure-log.js";

export type CommandResult = { code: number | null; stdout: string; stderr: string; log: string };
export type CommitResult = { status: "committed" | "nothing" | "failed"; commit?: string; hooksBypassed: boolean; log: string };
export type AttemptResult = { ok: boolean; log: string };
export type PublishInput = { branch: string; title: string; body: string; base: string };
export type PublishDeps = {
  push?: (repo: string, branch: string) => Promise<AttemptResult>;
  createPr?: (repo: string, args: { title: string; body: string; base: string; head: string }) => Promise<AttemptResult>;
};
export type PublishResult = { push: AttemptResult; pr: AttemptResult | null };
export type MergePrDeps = { gh?: typeof gh; git?: typeof git };

function run(executable: "git" | "gh", args: string[], repo: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd: repo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      resolve({ code, stdout, stderr, log: extractFailureLog(combined) });
    });
  });
}

export const git = (repo: string, args: string[]): Promise<CommandResult> => run("git", args, repo);
export const gh = (repo: string, args: string[]): Promise<CommandResult> => run("gh", args, repo);
const normalize = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");
const originRef = (branch: string): string => `origin/${branch}`;
const originBranch = (ref: string): string | undefined => ref.startsWith("origin/") ? ref.slice("origin/".length) : undefined;

export async function changedPaths(repo: string): Promise<string[]> {
  const result = await git(repo, ["status", "--porcelain", "-z"]);
  if (result.code !== 0) throw new Error(result.log || "git status failed");
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.push(normalize(path));
    if (status.includes("R") || status.includes("C")) i++;
  }
  return paths;
}

export async function isCleanTree(repo: string): Promise<boolean> {
  return (await changedPaths(repo)).length === 0;
}

export async function checkoutFreshBranch(repo: string, branch: string, base: string): Promise<void> {
  const remoteBranch = originBranch(base);
  if (remoteBranch) {
    const fetched = await fetchOriginBranch(repo, remoteBranch, git);
    if (!fetched.ok) throw new Error(fetched.log);
  }

  const exists = await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (exists.code !== 0) {
    const create = await git(repo, ["checkout", "-b", branch, base]);
    if (create.code !== 0) throw new Error(create.log || exists.log || `failed to create branch ${branch} from base ${base}`);
    return;
  }

  const checkout = await git(repo, ["checkout", branch]);
  if (checkout.code !== 0) throw new Error(checkout.log || `failed to checkout existing branch ${branch}`);

  const reset = await git(repo, ["reset", "--hard", base]);
  if (reset.code !== 0) {
    const log = reset.log || `git reset --hard ${base} failed`;
    throw new Error(`failed to reset branch ${branch} to base ${base}: ${log}`);
  }
}

async function fetchOriginBranch(
  repo: string,
  branch: string,
  runGit: typeof git,
): Promise<AttemptResult> {
  const fetched = await runGit(repo, [
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  if (fetched.code === 0) return { ok: true, log: fetched.log };
  return {
    ok: false,
    log: fetched.log || `failed to fetch origin/${branch}`,
  };
}

export async function checkoutIntegrationBranch(
  repo: string,
  branch: string,
  base: string,
): Promise<void> {
  if (branch === base) throw new Error("integration branch must differ from its final target");
  if (!(await isCleanTree(repo))) throw new Error("working tree is not clean");

  const fetched = await git(repo, ["fetch", "origin"]);
  if (fetched.code !== 0) throw new Error(fetched.log || "failed to fetch origin");

  const remoteExists = (await git(repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`])).code === 0;
  const localExists = (await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code === 0;

  if (localExists) {
    const checkout = await git(repo, ["checkout", branch]);
    if (checkout.code !== 0) throw new Error(checkout.log || `failed to checkout integration branch ${branch}`);
  } else if (remoteExists) {
    const checkout = await git(repo, ["checkout", "-b", branch, `origin/${branch}`]);
    if (checkout.code !== 0) throw new Error(checkout.log || `failed to track integration branch ${branch}`);
  } else {
    const checkout = await git(repo, ["checkout", "-b", branch, `origin/${base}`]);
    if (checkout.code !== 0) throw new Error(checkout.log || `failed to create integration branch ${branch}`);
  }

  if (remoteExists) {
    const pull = await git(repo, ["pull", "--ff-only", "origin", branch]);
    if (pull.code !== 0) throw new Error(pull.log || `failed to update integration branch ${branch}`);
    return;
  }

  const pushed = await push(repo, branch);
  if (!pushed.ok) throw new Error(pushed.log || `failed to publish integration branch ${branch}`);
}

export async function commitAll(repo: string, message: string): Promise<CommitResult> {
  if (await isCleanTree(repo)) return { status: "nothing", hooksBypassed: false, log: "" };
  const add = await git(repo, ["add", "--", "."]);
  if (add.code !== 0) return { status: "failed", hooksBypassed: false, log: add.log };
  const staged = await git(repo, ["diff", "--cached", "--name-only"]);
  if (staged.code !== 0) return { status: "failed", hooksBypassed: false, log: staged.log };
  if (!staged.stdout.trim()) return { status: "nothing", hooksBypassed: false, log: "" };

  let firstLog = "";
  for (const bypass of [false, true]) {
    const args = ["commit", "-m", message];
    if (bypass) args.push("--no-verify");
    const commit = await git(repo, args);
    if (commit.code === 0) {
      const rev = await git(repo, ["rev-parse", "HEAD"]);
      return { status: "committed", commit: rev.stdout.trim() || undefined, hooksBypassed: bypass, log: [firstLog, commit.log].filter(Boolean).join("\n") };
    }
    firstLog = [firstLog, commit.log].filter(Boolean).join("\n");
  }
  return { status: "failed", hooksBypassed: true, log: firstLog };
}

async function retry(times: number, action: () => Promise<CommandResult>): Promise<AttemptResult> {
  let lastLog = "";
  for (let i = 0; i < times; i++) {
    const result = await action();
    lastLog = result.log;
    if (result.code === 0) return { ok: true, log: result.log };
  }
  return { ok: false, log: `failed after ${times} attempts: ${lastLog}` };
}

export function push(repo: string, branch: string): Promise<AttemptResult> {
  return retry(3, () => git(repo, ["push", "-u", "origin", branch]));
}

export function createPr(repo: string, args: { title: string; body: string; base: string; head: string }): Promise<AttemptResult> {
  return retry(3, () => gh(repo, ["pr", "create", "--title", args.title, "--body", args.body, "--base", args.base, "--head", args.head]));
}

export async function mergePr(repo: string, args: { branch: string; base: string }, deps: MergePrDeps = {}): Promise<AttemptResult> {
  const runGh = deps.gh ?? gh;
  const runGit = deps.git ?? git;

  const merge = await runGh(repo, ["pr", "merge", args.branch, "--merge"]);
  if (merge.code !== 0) return { ok: false, log: merge.log };

  const fetched = await fetchOriginBranch(repo, args.base, runGit);
  if (!fetched.ok) return fetched;

  const checkout = await runGit(repo, ["checkout", "--detach", originRef(args.base)]);
  if (checkout.code !== 0) return { ok: false, log: checkout.log };
  return {
    ok: true,
    log: [merge.log, fetched.log, checkout.log].filter(Boolean).join("\n"),
  };
}

function failedAttempt(error: unknown): AttemptResult {
  return { ok: false, log: error instanceof Error ? error.message : String(error) };
}

async function attempt(action: () => Promise<AttemptResult>): Promise<AttemptResult> {
  try {
    return await action();
  } catch (error) {
    return failedAttempt(error);
  }
}

export async function publish(repo: string, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const pushAttempt = await attempt(() => (deps.push ?? push)(repo, input.branch));
  if (!pushAttempt.ok) return { push: pushAttempt, pr: null };

  const prAttempt = await attempt(() =>
    (deps.createPr ?? createPr)(repo, {
      title: input.title,
      body: input.body,
      base: input.base,
      head: input.branch,
    }),
  );
  return { push: pushAttempt, pr: prAttempt };
}
