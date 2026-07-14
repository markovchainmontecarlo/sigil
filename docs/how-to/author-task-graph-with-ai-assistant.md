# Author a task graph with an AI assistant

Use this guide when a code assistant already has the accepted development discussion or Markdown plan. The assistant should create the task graph directly rather than invoke Sigil planning.

## Give the assistant the outcome

Ask the assistant to use the current conversation and repository evidence:

> Create a Sigil task graph for what we have discussed. Read the active Markdown plan if one exists, verify its concrete claims against the repository, define architecture and task interfaces, use observable acceptance criteria and focused verification, validate the graph, and repair every validation error.

The assistant should use the most recently accepted plan when the reference is clear. If more than one plan could be meant, it should ask which one.

## Inspect the public schema

```sh
sigil task-graph schema --out /path/to/task-graph.schema.json
```

The emitted schema is the authority for the installed contract version and field types.

## Investigate before decomposing tasks

The assistant should first decide whether the request is one cohesive change. It should map relevant files to their responsibilities and trace current ownership, state flow, callers, tests, configuration, and gates. Claims from a discussion or Markdown plan remain proposals until repository evidence verifies them.

For meaningful design decisions, the assistant should compare viable options and select one. It should then record:

- the observable graph goal;
- the selected architecture and dependency direction;
- constraints every task preserves;
- explicit non-goals;
- the smallest cohesive implementation tasks;
- produced and consumed interfaces for every dependency;
- observable acceptance criteria;
- focused command checks or justified manual checks;
- evidence-backed file guidance anchored to stable symbols.

Before validation, check requirement coverage, task size, placeholder text, undefined names, and cross-task interface consistency.

## Store and validate the graph

Store the graph beneath `<repo>/.sigil/runs/`, then run:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/repo/.sigil/runs/my-change/task-graph.json
```

Repair every parse, structural, path, dependency, interface, cycle, and verification error before implementation. Use `--json` when another tool needs the validation result.

## Continue without planning again

Once the graph is accepted, follow [Implement an accepted task graph](./implement-accepted-task-graph.md). Do not pass the same plan through `software-change --brief` unless the developer explicitly asks Sigil to replan.
