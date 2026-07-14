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

1. Confirm the intent is one cohesive change and define its scope.
2. Map relevant files to their responsibilities and trace ownership, state flow, callers, tests, configuration, and gates.
3. Record the observable goal, selected architecture, constraints, and non-goals.
4. Divide the change into the smallest cohesive tasks worth implementing, verifying, committing, and reviewing independently.
5. Give every dependency explicit produced and consumed interfaces.
6. Keep acceptance criteria about observable outcomes. Add focused command checks or justified manual checks without replacing configured gates.
7. List evidence-backed file guidance anchored to stable symbols. Implementation may follow justified dependencies beyond those starting points.
8. Check requirement coverage, placeholders, task size, and cross-task name consistency.
9. Write the graph under the ignored `<repo>/.sigil/runs/` directory unless the user supplies another durable path.

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
