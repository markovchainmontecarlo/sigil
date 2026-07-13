# Author a task graph with an AI assistant

Use this guide when a code assistant already has the accepted development discussion or Markdown plan. The assistant should create the task graph directly rather than invoke Sigil planning.

## Give the assistant the outcome

Ask the assistant to use the current conversation and repository evidence:

> Create a Sigil task graph for what we have discussed. Read the active Markdown plan if one exists, verify its concrete claims against the repository, use observable acceptance criteria, validate the graph, and repair every validation error.

The assistant should use the most recently accepted plan when the reference is clear. If the request could refer to more than one plan, it should ask which one.

## Inspect the public schema

The assistant can print the structural contract:

```sh
sigil task-graph schema
```

It can write the schema for editor or integration use:

```sh
sigil task-graph schema --out /path/to/task-graph.schema.json
```

## Write the graph

Store the graph beneath `<repo>/.sigil/runs/`. `sigil setup` adds this directory to `.gitignore`, so the graph remains available locally without entering Git. The graph should contain:

- one short project slug and an optional goal;
- coherent tasks with stable identifiers;
- real dependency relationships;
- acceptance criteria describing observable outcomes;
- evidence-backed file actions and details.

Dependencies and diagrams may be omitted when empty and are normalized by validation. File entries guide implementation, but implementation may change additional files when they are required to complete the task correctly.

## Validate until clean

Run:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/repo/.sigil/runs/my-change/task-graph.json
```

Use `--json` when another tool needs the validation result. Repair parse errors, structural errors, unknown dependencies, cycles, and paths outside the repository before implementation.

## Continue without planning again

Once the graph is accepted, follow [Implement an accepted task graph](./implement-accepted-task-graph.md). Do not pass the same plan through `software-change --brief` unless the developer explicitly asks Sigil to replan.
