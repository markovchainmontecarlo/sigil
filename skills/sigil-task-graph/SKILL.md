---
name: sigil-task-graph
description: "Create and validate a Sigil task graph from an accepted developer conversation or Markdown plan, then run implementation without repeating planning when authorized."
---

# Sigil task-graph authoring

Use this skill for AI-assisted development. The current code assistant already owns the development conversation and translates the accepted intent into Sigil's task-graph contract. Sigil validates and implements that graph. Do not call Sigil planning unless the user explicitly requests agentic planning or replanning.

Read the [task-graph reference](../../docs/reference/task-graph.md) before writing the graph. Use [SIGIL_USAGE.md](../../SIGIL_USAGE.md) for exact commands and authority boundaries.

## Start from accepted context

Use the current conversation, explicitly accepted requirements, and repository evidence. When an active Markdown plan exists, verify that the file exists and read it in full. Resolve an omitted filename against the active or most recently accepted plan. Ask which plan to use only when more than one remains genuinely plausible.

Treat the discussion and plan as intent, not proof. Verify concrete claims about current files, behavior, dependencies, and tests before encoding them into the graph.

## Author the task graph

1. Choose a short kebab-case project name and state the overall goal.
2. Divide the change into coherent, independently verifiable tasks.
3. Give every task a stable identifier, title, summary, real dependencies, and observable acceptance criteria.
4. List evidence-backed file actions and details. These files are starting points rather than a restrictive allowlist; implementation may follow justified dependencies.
5. Keep acceptance criteria about outcomes. Do not preserve a stale mechanism merely because it appeared in the discussion or plan.
6. Write the graph under the ignored `<repo>/.sigil/runs/` directory unless the user supplies another durable path.

Use the public schema when the contract is uncertain:

```sh
sigil task-graph schema
```

## Validate and repair

Run deterministic validation before implementation:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/task-graph.json
```

Read every validation error, repair the graph, and rerun validation until it succeeds. Do not weaken acceptance criteria or remove required work merely to satisfy the validator.

Present a concise summary of the tasks, dependency order, and important authority boundary when the user has not already authorized implementation.

## Implement the accepted graph

When implementation is authorized, run:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/task-graph.json
```

Implementation requires a clean repository, creates a branch, commits verified tasks, runs configured gates, and reviews the result. It remains local unless publication is explicitly requested:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/task-graph.json --publish
```

Publication requires explicit authority. Do not infer it from permission to edit, implement, commit, or review.

## Switch to agentic development only when requested

Use `software-change --brief` when the developer explicitly asks Sigil to plan or replan the change. Use `probe` when safe experiments are required to determine the correct change. Use `breakdown` and `dispatch` for dependency-ordered program delivery.

The existence of a Markdown plan does not select agentic planning. “Implement this plan” means translate the active plan into a task graph and enter implementation unless the developer asks Sigil to plan again.
