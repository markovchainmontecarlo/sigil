# Implement an accepted task graph

Use this guide after an AI assistant, `plan`, or `probe` has produced a task graph the developer accepts.

## Validate the graph

Always validate against the target repository:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/task-graph.json
```

Validation resolves repository-relative paths and rejects paths that escape the target repository. It also rejects malformed tasks, unknown dependencies, and dependency cycles.

## Prepare the repository

Implementation requires a clean working tree and a configured base branch. Commit, stash, or move unrelated work before starting. Configure non-interactive build and test gates in `sigil.config.json`.

## Implement locally

Run:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/task-graph.json
```

Sigil validates the graph, saves a normalized copy, creates the implementation branch, establishes a baseline, and executes tasks in dependency order. Each completed task receives a verified commit. Final gates and review run after all tasks complete.

Inspect the branch, commits, Git diff, failed checks, and review findings before publishing.

## Add implementation-only guidance

Use `--instructions` for execution guidance that should not change the accepted task graph:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/task-graph.json --instructions /path/to/instructions.md
```

Instructions are orientation rather than proof. Implementation verifies important claims against the repository.

## Publish explicitly

When publication is authorized, add `--publish`:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/task-graph.json --publish
```

Publication occurs only after implementation and review succeed. Without `--publish`, the command succeeds or fails based only on the local implementation and review.
