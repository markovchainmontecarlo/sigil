# Migration contracts

## Workflow input

```ts
type MigrationInput = {
  repo: string;
  targetFile: string;
  backlogFile: string;
  runDir: string;
};
```

CLI mapping:

```text
repo        -> --repo <worktree>
targetFile  -> --target <target.md>
backlogFile -> --backlog <backlog.json>
runDir      -> --run-dir <directory>
```

## Backlog

```ts
type MigrationBacklog = {
  contractVersion: 1;
  goal: string;
  protectedPaths?: string[];
  items: MigrationItem[];
};

type MigrationItem = {
  id: string;
  intent: string;
  brief: string;
  focus?: string[];
  dependsOn: string[];
  commitMessage: string;
};
```

`focus` is advisory. It tells the Refactor Sigil where to begin but does not restrict dependency discovery. Every repository path is available when justified by the intent unless it is under a top-level `protectedPaths` entry.

Rules:

- Use unique lowercase kebab-case IDs.
- Reference only existing item IDs in `dependsOn`.
- Reject self-dependencies and cycles.
- Describe the item outcome in `intent`.
- Put invariants, constraints, acceptance targets, and exclusions in `brief`.
- Use `focus` for likely starting points, not a predicted file manifest.
- Use `protectedPaths` only for genuine hard boundaries.
- Give each verified checkpoint a meaningful `commitMessage`.

Example:

```json
{
  "contractVersion": 1,
  "goal": "Move the repository to cohesive feature modules with a thin CLI.",
  "protectedPaths": [".github/workflows"],
  "items": [
    {
      "id": "software-change",
      "intent": "Co-locate the single-change workflow, stages, prompts, and tests.",
      "brief": "Preserve public behavior and the typed task-graph seam. Remove obsolete locations in the same item.",
      "focus": ["src/workflows/software-change", "src/contracts/task-graph.ts"],
      "dependsOn": [],
      "commitMessage": "Organize the software change workflow"
    },
    {
      "id": "thin-cli",
      "intent": "Move CLI parsing and formatting into command adapters.",
      "brief": "Keep workflow logic out of the process entrypoint.",
      "focus": ["src/cli.ts", "src/help.ts"],
      "dependsOn": ["software-change"],
      "commitMessage": "Extract CLI command adapters"
    }
  ]
}
```

## Runtime state

```ts
type MigrationState = {
  contractVersion: 1;
  branch: string;
  baseHead: string;
  backlogHash: string;
  targetHash: string;
  completed: Array<{ id: string; commit: string }>;
  discoveries: Record<string, Array<{ path: string; justification: string }>>;
};
```

`completed` is the resumable Git checkpoint. `discoveries` records justified paths changed beyond each item's initial focus without rewriting the caller-owned backlog.

## Evidence layout

```text
<run-dir>/
  state.json
  events.jsonl
  items/<id>/
    attempt-<n>/
      input.json
      events.jsonl
      status.json
      refactor-events.jsonl
      refactor-plan.json
      refactor-reviews/
      result.json | error.json
      checkpoint.json
      failure.json
      diff.patch
      status.txt
  final/
    round-<n>-architecture-review.json
    round-<n>-behavior-review.json
```
