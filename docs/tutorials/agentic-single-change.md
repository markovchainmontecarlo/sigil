# Run an agentic single change

This tutorial begins where [AI-assisted development](./first-change-with-ai-assistant.md) ends. The implementation workflow is the same, but Sigil now owns investigation and planning before it produces the task graph.

## Choose agentic planning deliberately

Use agentic planning when you want independent planning perspectives, when you have not already worked through the requirements with a code assistant, or when the change needs Sigil-managed investigation. Do not select it merely because a Markdown plan exists.

If the right change depends on safe behavioral experiments, use `probe`. If the change is already understood and you only want a task graph, use `plan`. If you want one complete local change, use `software-change`.

## Run a complete agentic change

Start from a clean repository and provide a concise intent:

```sh
sigil software-change --repo /path/to/repo --intent "Add the requested behavior"
```

Use a brief when Sigil planning should read requirements or constraints from a file:

```sh
sigil software-change --repo /path/to/repo --intent "Implement the accepted design" --brief /path/to/context.md
```

Sigil runs configured planners, validates the produced task graph, implements it, runs gates, and reviews the result. The resulting branch stays local.

## Create a task graph without implementing it

Run `plan` when the task graph itself is the desired output:

```sh
sigil plan --repo /path/to/repo --intent "Add the requested behavior" --out /path/to/repo/.sigil/runs/my-change/task-graph.json
sigil task-graph validate --repo /path/to/repo /path/to/repo/.sigil/runs/my-change/task-graph.json
```

After accepting the graph, enter implementation directly:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/repo/.sigil/runs/my-change/task-graph.json
```

Do not run planning again after accepting the graph.

## Probe uncertain behavior

Use probe planning when repository behavior must be exercised before the correct change can be planned:

```sh
sigil probe --repo /path/to/repo --intent "Determine and fix the failure" --out /path/to/repo/.sigil/runs/my-change/task-graph.json
sigil implement --repo /path/to/repo --task-file /path/to/repo/.sigil/runs/my-change/task-graph.json
```

Probe commands run in an isolated sandbox. The target repository remains unchanged until implementation consumes the accepted graph.

## Continue to program delivery

Use [Deliver a multi-change program](./agentic-program-delivery.md) when the desired outcome requires several dependency-ordered pull requests rather than one change.
