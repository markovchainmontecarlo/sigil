import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  changedPaths,
  checkoutFreshBranch,
  checkoutIntegrationBranch,
  commitAll,
  createPr,
  mergePr,
  publish,
  push,
} from "../src/git.js";

function run(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigil-git-test-"));
  run(dir, ["init"]);
  run(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["config", "user.name", "Test User"]);
  run(dir, ["config", "core.hooksPath", ".git/hooks"]);
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, "old-name.txt"), "old\n");
  run(dir, ["add", "."]);
  run(dir, ["commit", "-m", "initial"]);
  return dir;
}

describe("git helpers", () => {
  test("createPr reuses an existing pull request", async () => {
    const calls: string[][] = [];
    const result = await createPr("/repo", { title: "Title", body: "Body", base: "main", head: "change" }, {
      gh: async (_repo, args) => {
        calls.push(args);
        return { code: 0, stdout: "1\n", stderr: "", log: "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["pr", "list"]);
  });

  test("createPr returns typed matching remote evidence and refuses conflicting identity", async () => {
    const matching = await createPr("/repo", { title: "Title", body: "Body", base: "main", head: "change" }, {
      gh: async () => ({ code: 0, stdout: JSON.stringify([{
        number: 12, headRefName: "change", baseRefName: "main", state: "OPEN",
        headRefOid: "abc", mergeCommit: null, url: "https://example.test/pr/12",
      }]), stderr: "", log: "" }),
    });
    const conflicting = await createPr("/repo", { title: "Title", body: "Body", base: "main", head: "change" }, {
      gh: async () => ({ code: 0, stdout: JSON.stringify([{
        number: 13, headRefName: "other", baseRefName: "main", state: "OPEN",
      }]), stderr: "", log: "" }),
    });

    expect(matching.evidence).toEqual({ number: 12, head: "change", base: "main", state: "OPEN",
      headCommit: "abc", mergedCommit: undefined, url: "https://example.test/pr/12" });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.log).toContain("identity conflict");
  });

  test("mergePr reuses matching merged evidence without another merge request", async () => {
    const ghCalls: string[][] = [];
    const result = await mergePr("/repo", { branch: "change", base: "main" }, {
      gh: async (_repo, args) => {
        ghCalls.push(args);
        return { code: 0, stdout: JSON.stringify({ number: 4, headRefName: "change", baseRefName: "main",
          state: "MERGED", headRefOid: "head", mergeCommit: { oid: "merged" } }), stderr: "", log: "" };
      },
      git: async (_repo, args) => ({ code: 0, stdout: "", stderr: "", log: args.join(" ") }),
    });

    expect(result.ok).toBe(true);
    expect(result.evidence?.mergedCommit).toBe("merged");
    expect(ghCalls.some((args) => args[1] === "merge")).toBe(false);
  });

  test("commitAll commits changes and reports nothing on a clean tree", async () => {
    const dir = repo();
    writeFileSync(join(dir, "tracked.txt"), "two\n");

    const committed = await commitAll(dir, "update tracked");
    const nothing = await commitAll(dir, "nothing to commit");

    expect(committed.status).toBe("committed");
    expect(committed.hooksBypassed).toBe(false);
    expect(committed.commit).toBeTruthy();
    expect(nothing.status).toBe("nothing");
  });

  test("commitAll reports failed when git add fails", async () => {
    const dir = repo();
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    writeFileSync(join(dir, ".git", "index.lock"), "locked");

    const result = await commitAll(dir, "cannot add");

    expect(result.status).toBe("failed");
    expect(result.hooksBypassed).toBe(false);
  });

  test("commitAll reports hook bypass when final no-verify attempt succeeds", async () => {
    const dir = repo();
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho stop >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(dir, "tracked.txt"), "hooked\n");

    const result = await commitAll(dir, "bypass hook");

    expect(result.status).toBe("committed");
    expect(result.hooksBypassed).toBe(true);
    expect(result.log).toContain("stop");
  });

  test("checkoutFreshBranch resets an existing branch to the named base", async () => {
    const dir = repo();
    run(dir, ["branch", "-M", "main"]);

    await checkoutFreshBranch(dir, "impl/fresh", "main");
    writeFileSync(join(dir, "tracked.txt"), "branch change\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "branch change"]);

    await checkoutFreshBranch(dir, "impl/fresh", "main");

    expect(run(dir, ["rev-parse", "HEAD"])).toBe(run(dir, ["rev-parse", "main"]));
    expect(run(dir, ["branch", "--show-current"]).trim()).toBe("impl/fresh");
  });

  test("checkoutFreshBranch creates a missing branch from the named base", async () => {
    const dir = repo();
    run(dir, ["branch", "-M", "main"]);
    run(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "feature.txt"), "feature only\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "feature change"]);

    await checkoutFreshBranch(dir, "impl/fresh", "main");

    expect(run(dir, ["rev-parse", "HEAD"])).toBe(run(dir, ["rev-parse", "main"]));
    expect(run(dir, ["branch", "--show-current"]).trim()).toBe("impl/fresh");
    expect(run(dir, ["ls-tree", "--name-only", "HEAD"])).not.toContain("feature.txt");
  });

  test("checkoutFreshBranch refreshes an origin base before creating an implementation branch", async () => {
    const dir = repo();
    const origin = mkdtempSync(join(tmpdir(), "sigil-git-origin-"));
    run(origin, ["init", "--bare"]);
    run(dir, ["branch", "-M", "main"]);
    run(dir, ["remote", "add", "origin", origin]);
    run(dir, ["push", "-u", "origin", "main"]);

    const contributor = mkdtempSync(join(tmpdir(), "sigil-git-contributor-"));
    execFileSync("git", ["clone", "-b", "main", origin, contributor], { encoding: "utf8" });
    run(contributor, ["config", "user.email", "test@example.com"]);
    run(contributor, ["config", "user.name", "Test User"]);
    writeFileSync(join(contributor, "remote.txt"), "remote change\n");
    run(contributor, ["add", "."]);
    run(contributor, ["commit", "-m", "remote change"]);
    run(contributor, ["push", "origin", "main"]);

    await checkoutFreshBranch(dir, "impl/fresh", "origin/main");

    expect(run(dir, ["branch", "--show-current"]).trim()).toBe("impl/fresh");
    expect(run(dir, ["rev-parse", "HEAD"])).toBe(run(dir, ["rev-parse", "origin/main"]));
    expect(run(dir, ["ls-tree", "--name-only", "HEAD"])).toContain("remote.txt");
  });

  test("checkoutFreshBranch ignores same-named tags when looking for an existing branch", async () => {
    const dir = repo();
    run(dir, ["branch", "-M", "main"]);
    run(dir, ["tag", "impl/fresh"]);

    await checkoutFreshBranch(dir, "impl/fresh", "main");

    expect(run(dir, ["branch", "--show-current"]).trim()).toBe("impl/fresh");
    expect(run(dir, ["rev-parse", "--verify", "refs/heads/impl/fresh"]).trim()).toBeTruthy();
  });

  test("checkoutFreshBranch names the branch and base when reset fails", async () => {
    const dir = repo();
    run(dir, ["checkout", "-b", "impl/fresh"]);

    await expect(checkoutFreshBranch(dir, "impl/fresh", "missing-base")).rejects.toThrow(/impl\/fresh.*missing-base/);
  });

  test("checkoutIntegrationBranch creates a remote branch and preserves accumulated commits", async () => {
    const dir = repo();
    const origin = mkdtempSync(join(tmpdir(), "sigil-git-origin-"));
    run(origin, ["init", "--bare"]);
    run(dir, ["branch", "-M", "main"]);
    run(dir, ["remote", "add", "origin", origin]);
    run(dir, ["push", "-u", "origin", "main"]);

    await checkoutIntegrationBranch(dir, "feature/mission", "main");
    writeFileSync(join(dir, "mission.txt"), "accumulated\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-m", "accumulate mission"]);
    const accumulated = run(dir, ["rev-parse", "HEAD"]);

    run(dir, ["checkout", "main"]);
    await checkoutIntegrationBranch(dir, "feature/mission", "main");

    expect(run(dir, ["rev-parse", "HEAD"])).toBe(accumulated);
    expect(run(origin, ["rev-parse", "refs/heads/feature/mission"]).trim()).toBeTruthy();
  });

  test("push failure reports the last attempt once", async () => {
    const dir = repo();
    const branch = run(dir, ["branch", "--show-current"]).trim();

    const result = await push(dir, branch);

    expect(result.ok).toBe(false);
    expect(result.log).toContain("failed after 3 attempts:");
    expect((result.log.match(/'origin' does not appear to be a git repository/g) ?? []).length).toBe(1);
  });

  test("publish pushes first, then creates a PR from the branch", async () => {
    const calls: string[] = [];
    const prArgs: unknown[] = [];

    const result = await publish(
      "/repo",
      { branch: "impl/change", title: "Title", body: "Body", base: "main" },
      {
        push: async (repo, branch) => {
          calls.push(`push:${repo}:${branch}`);
          return { ok: true, log: "pushed" };
        },
        createPr: async (repo, args) => {
          calls.push(`pr:${repo}`);
          prArgs.push(args);
          return { ok: true, log: "created" };
        },
      },
    );

    expect(calls).toEqual(["push:/repo:impl/change", "pr:/repo"]);
    expect(prArgs).toEqual([{ title: "Title", body: "Body", base: "main", head: "impl/change" }]);
    expect(result).toEqual({ push: { ok: true, log: "pushed" }, pr: { ok: true, log: "created" } });
  });

  test("publish returns a failed push attempt without creating a PR", async () => {
    const result = await publish(
      "/repo",
      { branch: "impl/change", title: "Title", body: "Body", base: "main" },
      {
        push: async () => ({ ok: false, log: "no remote" }),
        createPr: async () => {
          throw new Error("createPr should not be called");
        },
      },
    );

    expect(result).toEqual({ push: { ok: false, log: "no remote" }, pr: null });
  });

  test("publish converts thrown delivery errors into failed attempts", async () => {
    const thrownPush = await publish(
      "/repo",
      { branch: "impl/change", title: "Title", body: "Body", base: "main" },
      {
        push: async () => {
          throw new Error("push exploded");
        },
      },
    );

    const thrownCreatePr = await publish(
      "/repo",
      { branch: "impl/change", title: "Title", body: "Body", base: "main" },
      {
        push: async () => ({ ok: true, log: "pushed" }),
        createPr: async () => {
          throw new Error("gh exploded");
        },
      },
    );

    expect(thrownPush).toEqual({ push: { ok: false, log: "push exploded" }, pr: null });
    expect(thrownCreatePr).toEqual({ push: { ok: true, log: "pushed" }, pr: { ok: false, log: "gh exploded" } });
  });

  test("mergePr merges remotely, refreshes the remote base, and detaches there", async () => {
    const ghCalls: string[][] = [];
    const gitCalls: string[][] = [];

    const result = await mergePr("/repo", { branch: "sigil/change", base: "main" }, {
      gh: async (_repo, args) => {
        ghCalls.push(args);
        return args[1] === "view"
          ? { code: 0, stdout: ghCalls.length === 1 ? "OPEN\n" : "MERGED\n", stderr: "", log: "" }
          : { code: 0, stdout: "", stderr: "", log: "merged" };
      },
      git: async (_repo, args) => {
        gitCalls.push(args);
        return { code: 0, stdout: "", stderr: "", log: args.join(" ") };
      },
    });

    expect(result.ok).toBe(true);
    expect(ghCalls).toEqual([
      ["pr", "view", "sigil/change", "--json", "number,headRefName,baseRefName,state,headRefOid,mergeCommit,url"],
      ["pr", "merge", "sigil/change", "--merge", "--auto"],
      ["pr", "view", "sigil/change", "--json", "number,headRefName,baseRefName,state,headRefOid,mergeCommit,url"],
      ["pr", "view", "sigil/change", "--json", "number,headRefName,baseRefName,state,headRefOid,mergeCommit,url"],
    ]);
    expect(ghCalls[0]).not.toContain("--delete-branch");
    expect(gitCalls).toEqual([
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["checkout", "--detach", "origin/main"],
    ]);
    expect(gitCalls.flat()).not.toContain("pull");
  });

  test("mergePr reports synchronization failures after a successful remote merge", async () => {
    const gitCalls: string[][] = [];

    const result = await mergePr("/repo", { branch: "sigil/change", base: "main" }, {
      gh: async (_repo, args) => args[1] === "view"
        ? { code: 0, stdout: "MERGED\n", stderr: "", log: "" }
        : { code: 0, stdout: "", stderr: "", log: "merged" },
      git: async (_repo, args) => {
        gitCalls.push(args);
        return { code: 1, stdout: "", stderr: "fetch failed", log: "fetch failed" };
      },
    });

    expect(result).toEqual({ ok: false, log: "fetch failed" });
    expect(gitCalls).toEqual([
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    ]);
  });

  test("changedPaths returns modified, added, and renamed repo-relative paths", async () => {
    const dir = repo();
    writeFileSync(join(dir, "tracked.txt"), "modified\n");
    writeFileSync(join(dir, "added.txt"), "added\n");
    run(dir, ["mv", "old-name.txt", "new-name.txt"]);

    const paths = await changedPaths(dir);

    expect(paths.sort()).toEqual(["added.txt", "new-name.txt", "tracked.txt"]);
  });
});
