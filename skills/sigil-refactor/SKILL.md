---
name: sigil-refactor
description: Run one bounded, behavior-preserving Sigil refactor with explicit intent, advisory focus, protected paths, deterministic gates, independent reviews, structured recovery, and evidence inspection. Use when a user asks to refactor one subsystem or architectural boundary without a repository-wide queue, or asks for the input shape needed by `sigil refactor`.
---

# Sigil Refactor

Run one verified structural change. Do not create a migration backlog for a single refactor.

## Prepare the input

Require:

```ts
type RefactorInput = {
  repo: string;
  intent: string;
  brief?: string;
  focus?: string[];
  protectedPaths?: string[];
};
```

Read [references/contract.md](references/contract.md) when authoring the brief or interpreting results.

Express:

- `intent` as the structural outcome and preserved behavior.
- `brief` as invariants, constraints, acceptance targets, and explicit exclusions.
- `focus` as advisory starting paths, not a complete file prediction.
- `protectedPaths` only for paths the workflow must not modify. Every other relevant repository path remains available.

Keep the brief outside the target worktree. Require a clean Git worktree on a named branch.

## Run

Prefer the installed command when `sigil refactor --help` succeeds. Otherwise run the repository-local CLI containing the desired workflow version.

```sh
env -u CLAUDECODE sigil refactor \
  --repo <worktree> \
  --intent '<structural outcome while preserving behavior>' \
  --brief <run-root>/brief.md \
  --focus <path> \
  --protected-path <path>
```

Run long processes through an observable background execution session and poll them. Do not wrap the command in `nohup`. Use configured `workspace.bootstrap` for dependency preparation when it is available; do not invent a second preparation path.

During direct CLI execution, monitor stderr progress and the target Git state. The command does not expose its generated context artifact root before completion, so do not guess a `status.json` path. After completion, inspect the result-referenced event and review artifacts. Context status is distinct from the status, logs, result, and error files owned by a detached `run-sigil` worker.

A red baseline must recover before analysis begins. Every slice repair must pass build and test before the next slice, and every review repair must receive fresh independent reviews.

Treat repair budgets as local to the failure. Each distinct review finding, gate failure, and protected-path violation receives its own attempts. Continue fresh comprehensive review rounds while new findings are discovered. Do not apply one shared budget across the review phase.

Treat invalid structured output and thrown agent operations as recoverable local failures. Retry them in fresh agent contexts and preserve their validation evidence. Only an exhausted local operation returns a terminal Refactor result.

## Evaluate the result

Inspect the returned JSON fields and every referenced artifact:

- `planFile`
- `structureReviewFile`
- `behaviorReviewFile`
- `eventsFile`
- `changedFiles`
- `failures`
- `valid`
- `issues`

A recoverable failure may appear in attempt history even when the final result is valid. Treat unresolved failures, blocking reviews, red gates, or protected-path changes as incomplete work.

Run repository-native typecheck, tests, distribution checks when applicable, and `git diff --check`. Review the complete tracked and untracked diff before committing.

The refactor workflow does not create a branch, commit, publish, or merge. Commit and delivery remain caller-owned.
