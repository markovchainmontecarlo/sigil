---
name: sigil-migration
description: Create and run a complete repository migration as a dependency-ordered queue of verified Sigil refactors, with external target and backlog files, per-item commits, resumable checkpoints, automatic structured recovery, final repository-wide reviews, and delivery validation. Use when a user asks for a full rewrite, whole-codebase migration, architecture migration, refactor queue, or repository-wide structural change.
---

# Sigil Migration

Turn one repository-wide target into a queue of bounded refactors that collectively complete the migration.

## Prepare the inputs

Create these files outside the target worktree:

```text
<run-root>/
  target.md
  backlog.json
  run/                 # workflow-owned state and evidence
```

Read [references/contracts.md](references/contracts.md) before writing either input.

`target.md` must define the final structure, ownership boundaries, dependency direction, required behavior, invariants, exclusions, and verification targets.

`backlog.json` must divide the whole target into dependency-ordered, independently verifiable rewrites. Each item may name advisory focus paths. The Sigil follows justified dependencies anywhere in the repository except top-level protected paths.

## Prepare the worktree

Create a clean named branch from the intended base. Do not run migration against the primary worktree.

```sh
git -C <repo> worktree add -b <migration-branch> <worktree> <base>
```

Ensure repository dependencies are available without making the worktree dirty.

## Run the queue

Prefer the installed command when `sigil migrate --help` succeeds. Otherwise use the repository-local CLI containing the desired workflow version.

```sh
env -u CLAUDECODE sigil migrate \
  --repo <worktree> \
  --target <run-root>/target.md \
  --backlog <run-root>/backlog.json \
  --run-dir <run-root>/run \
  > <run-root>/result.json \
  2> <run-root>/stderr.log
```

Run through an observable background execution session and poll it. Do not use `nohup`. Never start a second migration while the first process is active.

## Monitor and recover

Poll:

```sh
ps -axo pid,ppid,stat,etime,command | grep -E 'src/cli.ts migrate|codex-acp' | grep -v grep || true
tail -80 <run-root>/stderr.log
tail -40 <run-root>/run/events.jsonl
cat <run-root>/run/state.json
cat <artifact-root>/status.json
git -C <worktree> status --short --branch
git -C <worktree> log --oneline <base>..HEAD
```

Treat justified dependency discovery as normal execution. Inspect `discoveries` for paths added beyond focus. Recovery is reserved for actual gate, review, provider, checkpoint, or protected-path failures.

Each red gate or blocking review must enter bounded recovery and then rerun the affected deterministic gates and fresh reviews. Final repair commits are checkpointed, so an interrupted final convergence resumes from its latest verified repository state.

Recovery budgets are local to each failure. A newly discovered finding receives a fresh repair budget and does not consume another finding's attempts.

Migration must write every item attempt directly to its own durable directory. An agent or schema exception must preserve the attempt events, status, plan and reviews produced so far, failed diff, repository status, and typed error before the worktree returns to the verified checkpoint.

Do not edit the target, backlog, state, or worktree while the process is active. After completed checkpoints exist, never reset to the original base. Resume when `HEAD` matches the recorded checkpoint, or when an item-owned checkpoint proves that its verified commit completed immediately before state persistence. The target and backlog hashes must still match.

## Finish

Require:

- every backlog item completed and committed;
- `result.valid` true;
- final architecture and behavior reviews nonblocking;
- a clean worktree;
- repository-native typecheck and full tests passing;
- distribution or installation validation when applicable;
- `git diff --check` passing;
- no duplicate legacy modules or prompt trees prohibited by the target.

Inspect all per-item attempts under `<run-root>/run/items/<id>/attempt-<n>/` and final review rounds under `<run-root>/run/final/`. Then push, open a PR, wait for required checks, and merge only when green.
