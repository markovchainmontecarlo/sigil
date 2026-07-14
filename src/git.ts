import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { extractFailureLog } from "./reports/failure-log.js";

export type CommandResult = { code: number | null; stdout: string; stderr: string; log: string };
export type CommitResult = { status: "committed" | "nothing" | "failed"; commit?: string; log: string };
export type PullRequestEvidence = {
  number: number;
  head: string;
  base: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headCommit?: string;
  mergedCommit?: string;
  url?: string;
};
export type AttemptResult = { ok: boolean; log: string; evidence?: PullRequestEvidence };
export type PublishInput = { branch: string; title: string; body: string; base: string };
export type PublishDeps = {
  push?: (repo: string, branch: string) => Promise<AttemptResult>;
  createPr?: (repo: string, args: { title: string; body: string; base: string; head: string }) => Promise<AttemptResult>;
  git?: typeof git;
};
export type PublishResult = { push: AttemptResult; pr: AttemptResult | null };
export type MergePrDeps = {
  gh?: typeof gh;
  git?: typeof git;
  wait?: (milliseconds: number) => Promise<void>;
  pollLimit?: number;
};
export type CreatePrDeps = { gh?: typeof gh };

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

export async function repositoryStateDigest(repo: string): Promise<string> {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(head.log || "git rev-parse HEAD failed");
  const diff = await git(repo, ["diff", "--binary", "HEAD", "--"]);
  if (diff.code !== 0) throw new Error(diff.log || "git diff HEAD failed");
  const untracked = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) throw new Error(untracked.log || "git ls-files failed");

  const digest = createHash("sha256");
  digest.update(head.stdout.trim()).update("\0").update(diff.stdout).update("\0");
  for (const path of untracked.stdout.split("\0").filter(Boolean).sort()) {
    digest.update(path).update("\0");
    const absolute = join(repo, path);
    const stat = await lstat(absolute);
    digest.update(String(stat.mode)).update("\0");
    digest.update(stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export async function repositoryPathsDigest(repo: string, paths: readonly string[]): Promise<string> {
  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    digest.update(path).update("\0");
    const absolute = join(repo, path);
    try {
      const stat = await lstat(absolute);
      digest.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) digest.update(await readlink(absolute));
      else if (stat.isDirectory()) {
        const head = await git(absolute, ["rev-parse", "HEAD"]);
        digest.update(head.code === 0 ? head.stdout.trim() : "directory");
      } else digest.update(await readFile(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("deleted");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
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
  if (await isCleanTree(repo)) return { status: "nothing", log: "" };
  const add = await git(repo, ["add", "--", "."]);
  if (add.code !== 0) return { status: "failed", log: add.log };
  const staged = await git(repo, ["diff", "--cached", "--name-only"]);
  if (staged.code !== 0) return { status: "failed", log: staged.log };
  if (!staged.stdout.trim()) return { status: "nothing", log: "" };

  const commit = await git(repo, ["commit", "-m", message]);
  if (commit.code !== 0) {
    return { status: "failed", log: commit.log };
  }

  const rev = await git(repo, ["rev-parse", "HEAD"]);
  return {
    status: "committed",
    commit: rev.stdout.trim() || undefined,
    log: commit.log,
  };
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

export async function createPr(
  repo: string,
  args: { title: string; body: string; base: string; head: string },
  deps: CreatePrDeps = {},
): Promise<AttemptResult> {
  const runGh = deps.gh ?? gh;
  const existing = await runGh(repo, [
    "pr", "list", "--head", args.head,
    "--state", "all", "--json", "number,headRefName,baseRefName,state,headRefOid,mergeCommit,url",
  ]);
  if (existing.code !== 0) return { ok: false, log: existing.log || "failed to inspect existing pull requests" };
  const observed = parsePullRequests(existing.stdout);
  const matching = observed.find((pr) => (pr.head === args.head && pr.base === args.base) || pr.number === 0);
  if (matching) return { ok: true, log: "pull request already exists", evidence: matching };
  if (observed.length > 0) return { ok: false, log: `pull request identity conflict for ${args.head} -> ${args.base}` };
  const created = await retry(3, () => runGh(repo, ["pr", "create", "--title", args.title, "--body", args.body, "--base", args.base, "--head", args.head]));
  if (!created.ok) return created;
  const inspected = await queryPullRequest(repo, { head: args.head, base: args.base }, { gh: runGh });
  return inspected.ok ? { ...created, evidence: inspected.evidence } : inspected;
}

export async function mergePr(repo: string, args: { branch: string; base: string }, deps: MergePrDeps = {}): Promise<AttemptResult> {
  const runGh = deps.gh ?? gh;
  const runGit = deps.git ?? git;
  const wait = deps.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollLimit = deps.pollLimit ?? 120;

  const before = await queryPullRequest(repo, { head: args.branch, base: args.base }, { gh: runGh });
  if (!before.ok) return before;
  if (before.evidence?.state === "MERGED") return synchronizeMerged(repo, args.base, before.evidence, runGit);
  if (before.evidence?.state === "CLOSED") return { ok: false, log: "pull request closed without merging", evidence: before.evidence };
  const merge = await runGh(repo, ["pr", "merge", args.branch, "--merge", "--auto"]);
  if (merge.code !== 0) return { ok: false, log: merge.log };

  let state = "";
  for (let poll = 0; poll < pollLimit; poll++) {
    const viewed = await queryPullRequest(repo, { head: args.branch, base: args.base }, { gh: runGh });
    if (!viewed.ok) return viewed;
    state = viewed.evidence?.state ?? "";
    if (state === "MERGED") break;
    if (state === "CLOSED") return { ok: false, log: "pull request closed without merging", evidence: viewed.evidence };
    await wait(5_000);
  }
  if (state !== "MERGED") return { ok: false, log: "timed out waiting for pull request to merge" };

  const after = await queryPullRequest(repo, { head: args.branch, base: args.base }, { gh: runGh });
  if (!after.ok || !after.evidence) return after;
  return synchronizeMerged(repo, args.base, after.evidence, runGit, merge.log);
}

export async function queryPullRequest(
  repo: string,
  args: { head: string; base: string },
  deps: CreatePrDeps = {},
): Promise<AttemptResult> {
  const result = await (deps.gh ?? gh)(repo, [
    "pr", "view", args.head, "--json", "number,headRefName,baseRefName,state,headRefOid,mergeCommit,url",
  ]);
  if (result.code !== 0) return { ok: false, log: result.log || "failed to inspect pull request" };
  const legacyState = result.stdout.trim().toUpperCase();
  if (["OPEN", "CLOSED", "MERGED"].includes(legacyState)) {
    return { ok: true, log: "pull request observed", evidence: { number: 0, head: args.head, base: args.base, state: legacyState as PullRequestEvidence["state"] } };
  }
  const prs = parsePullRequests(result.stdout);
  if (prs.length === 0) return { ok: false, log: "pull request not found" };
  const matching = prs.find((pr) => (pr.head === args.head && pr.base === args.base) || pr.number === 0);
  return matching
    ? { ok: true, log: "pull request observed", evidence: matching }
    : { ok: false, log: `pull request identity conflict for ${args.head} -> ${args.base}` };
}

function parsePullRequests(contents: string): PullRequestEvidence[] {
  if (!contents.trim()) return [];
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown> | Array<Record<string, unknown>>;
    if (typeof parsed !== "object" || parsed === null) throw new Error("legacy pull request count");
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map((value) => ({
      number: Number(value.number),
      head: String(value.headRefName),
      base: String(value.baseRefName),
      state: String(value.state).toUpperCase() as PullRequestEvidence["state"],
      headCommit: typeof value.headRefOid === "string" ? value.headRefOid : undefined,
      mergedCommit: typeof (value.mergeCommit as { oid?: unknown } | null)?.oid === "string"
        ? String((value.mergeCommit as { oid: string }).oid) : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
    }));
  } catch {
    return /^\d+$/.test(contents.trim()) && Number(contents.trim()) > 0
      ? [{ number: 0, head: "unknown", base: "unknown", state: "OPEN" }]
      : [];
  }
}

async function synchronizeMerged(
  repo: string,
  base: string,
  evidence: PullRequestEvidence,
  runGit: typeof git,
  mergeLog = "pull request already merged",
): Promise<AttemptResult> {
  const fetched = await fetchOriginBranch(repo, base, runGit);
  if (!fetched.ok) return fetched;

  const checkout = await runGit(repo, ["checkout", "--detach", originRef(base)]);
  if (checkout.code !== 0) return { ok: false, log: checkout.log };
  return {
    ok: true,
    log: [mergeLog, fetched.log, checkout.log].filter(Boolean).join("\n"),
    evidence,
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
  let pushAttempt: AttemptResult;
  if (!deps.push && await remoteBranchMatches(repo, input.branch, deps.git ?? git)) {
    pushAttempt = { ok: true, log: "remote branch already matches local commit" };
  } else {
    pushAttempt = await attempt(() => (deps.push ?? push)(repo, input.branch));
  }
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

async function remoteBranchMatches(repo: string, branch: string, runGit: typeof git): Promise<boolean> {
  const local = await runGit(repo, ["rev-parse", branch]);
  if (local.code !== 0 || !local.stdout.trim()) return false;
  const remote = await runGit(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (remote.code !== 0) return false;
  return remote.stdout.trim().split(/\s+/)[0] === local.stdout.trim();
}
