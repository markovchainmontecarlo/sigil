# Make your first change with an AI assistant

This tutorial uses AI-assisted development, the recommended first experience with Sigil. Your current code assistant turns the agreed requirements into a task graph. Sigil validates and implements that graph without repeating planning.

## What you will do

You will configure one repository, discuss a bounded change with your assistant, have the assistant create and validate a task graph, and run a local implementation. The result stays local unless you explicitly publish it.

## Install and configure Sigil

Install the CLI from the release archive as described in the root [README](../../README.md), then initialize the repository:

```sh
sigil setup --dir /path/to/repo
```

Edit `sigil.config.json`. Configure the agent roles used by implementation and review, and define non-interactive build and test commands under `evals`. Run the environment report if provider prerequisites are uncertain:

```sh
sigil discover-env --repo /path/to/repo
```

## Discuss one bounded change

Work with your assistant normally. Explain the desired outcome, constraints, non-goals, and what success looks like. Let the assistant inspect the repository and correct assumptions as the discussion develops.

If the discussion produces a Markdown plan, keep using it. The plan is part of the agreed requirements. Its presence does not require Sigil to plan again.

Choose a change small enough to review as one pull request.

## Ask the assistant to create the task graph

Once the requirements are clear, ask:

> Create and validate a Sigil task graph for what we have discussed. If there is an active Markdown plan, read it in full. Verify concrete claims against the repository, write outcome-based acceptance criteria, and show me the task summary before implementation.

Supported assistants can use the installed `sigil-task-graph` skill to produce the contract. The assistant should place the graph beneath the ignored `.sigil/runs/` directory.

The assistant validates it with:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/repo/.sigil/runs/my-change/task-graph.json
```

Validation checks document structure, task dependencies, cycles, and repository paths. The assistant should repair every validation error before continuing.

## Inspect the task summary

Check that the summary preserves the intended outcome, divides the change into coherent tasks, names real dependencies, and uses acceptance criteria you can observe. File entries are starting points based on repository evidence rather than a hard allowlist. Implementation may change additional files when they are required to complete the task correctly.

You do not need to edit JSON by hand. Ask the assistant to correct the graph if the summary is wrong.

## Implement locally

Start from a clean repository. Then run:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/repo/.sigil/runs/my-change/task-graph.json --brief /path/to/repo/.sigil/runs/my-change/brief.md
```

Sigil validates the graph again, creates an implementation branch, implements tasks in dependency order, commits verified work, runs configured checks, and reviews the complete change.

Inspect the branch, commits, Git diff, failed checks, and review findings before publication.

## Publish only when ready

When you are ready to push the branch and open a pull request, add `--publish`:

```sh
sigil implement --repo /path/to/repo --task-file /path/to/repo/.sigil/runs/my-change/task-graph.json --brief /path/to/repo/.sigil/runs/my-change/brief.md --publish
```

Without `--publish`, the branch remains local.

## Continue to agentic development

The task graph is the shared contract between planning and implementation. [Run an agentic single change](./agentic-single-change.md) shows how Sigil can produce the same contract from an intent or brief.
