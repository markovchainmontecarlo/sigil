# Sigil

<p align="center">
  <img src="./assets/sigil-logo.png" alt="Sigil logo" width="420" />
</p>

Sigil is a composable workflow system built from plain async TypeScript sigils over configured agents. It includes built-in software-change workflows and exposes both a CLI and a TypeScript authoring API.

## Install

Install from the latest GitHub release archive:

```sh
gh api repos/markovchainmontecarlo/sigil/contents/scripts/install.sh --jq .content | base64 -d | sh
```

The installer verifies the downloaded archive checksum, unpacks Sigil into `~/.sigil/lib`, runs `bun install --production --frozen-lockfile` there so native packages are materialized for the local platform, replaces the bundled skills under `~/.sigil/skills`, links those skills into the Claude Code and Codex discovery directories, installs the bundled man page when present, and writes a `sigil` launcher to `~/.local/bin`. Upgrade by re-running the installer; it replaces the existing install.

Codex and Claude both use subscription auth. The installer does not create or store API keys.

## Setup

In the repository you want to run Sigil against, create the default config:

```sh
sigil setup
```

Then edit [`sigil.config.json`](./sigil.config.json) and define the `evals` commands for that repo, such as build and test. Repositories that need dependencies or generated tool state before baseline gates can also define `workspace.bootstrap`. Unconfigured evals are skipped.

## CLI

The CLI verbs are `migrate`, `refactor`, `probe`, `plan`, `software-change`, `implement`, `review`, `breakdown`, `dispatch`, `validate`, `validate-workflow`, `validate-sigil`, `run-workflow`, `run-sigil`, `setup`, and `discover-env`. Run `sigil <verb> --help` for flags and exit codes. Use [SIGIL_USAGE.md](./SIGIL_USAGE.md) as the canonical operator reference.

## Build agent workflows

Sigil is built around a small set of workflow concepts:

- **[agent](./docs/explanation/primitives-and-composition.md#agent)**: one configured tool-using model object with its own context
- **[prompt step](./docs/explanation/primitives-and-composition.md#prompt-step)**: one instruction to one agent
- **[sequential context](./docs/explanation/primitives-and-composition.md#sequential-context)**: reuse one agent so later steps build on earlier investigation
- **[independent parallel analysis](./docs/explanation/primitives-and-composition.md#independent-parallel-analysis)**: run isolated agents at the same time for breadth and disagreement
- **[synthesis](./docs/explanation/primitives-and-composition.md#synthesis)**: join several outputs into one recommendation or report
- **[structured output](./docs/explanation/primitives-and-composition.md#structured-output)**: ask for machine-readable output when a workflow needs to branch
- **[artifact write](./docs/explanation/primitives-and-composition.md#artifact-write)**: require an agent turn to produce a named file
- **[eval gate](./docs/explanation/primitives-and-composition.md#eval-gate)**: run a configured deterministic check such as `build` or `test`
- **[shell or script step](./docs/explanation/primitives-and-composition.md#shell-or-script-step)**: run deterministic local logic when a model is the wrong tool
- **[nested sigil](./docs/explanation/primitives-and-composition.md#nested-sigil)**: call one sigil from another
- **[delivery policy](./docs/explanation/primitives-and-composition.md#delivery-policy)**: let the caller decide whether to publish, merge, queue, or stop

A sigil is a composable workflow unit: a plain async TypeScript callable with typed input and output. TypeScript itself provides the control flow: `if`, `for`, functions, arrays, and ordinary async calls. Sigil adds agent, artifact, gate, parallel, and nested-sigil primitives on top of that. Reuse the same agent object when later prompt steps should build on earlier context; create a new agent object when work should stay independent.

Some sigils are built in, such as `softwareChange`, `plan`, `implement`, `review`, `breakdown`, and `dispatch`. You can also save your own sigils in a repo, or write one temporarily for a substantial one-off request.

### A tiny custom sigil

This is the smallest useful workflow shape: one agent, a couple of prompt steps, one output file, and one named check.

```ts
import { sigil } from "sigil";

export const triageIssue = sigil(
  "triage-issue",
  async (ctx, input: { repo: string; issue: string }) => {
    await using analyst = ctx.agent("reviewer");

    const summary = await analyst.prompt(
      `Read this issue and summarize the likely problem in one paragraph.\n\n${input.issue}`,
    );
    await analyst.prompt("Write a minimal reproduction script.", {
      writes: "repro.sh",
      minBytes: 1,
    });

    const gate = await ctx.evals("build");
    if (!gate.ok && !gate.skipped) ctx.issue(`build red: ${gate.log}`);

    return {
      summary,
      issues: ctx.issues,
      repro: ctx.artifacts.path("repro.sh"),
    };
  },
);
```

That is the authoring surface in miniature: agent, prompt step, output file, check, result. Start here to learn the workflow shape. Add structured output later when a workflow needs typed branching.

See [examples/01-custom-sigil-minimal.ts](./examples/01-custom-sigil-minimal.ts) for the next step: the same minimal workflow shape with structured output added.

### Authoring model

| Concept | TypeScript surface |
| --- | --- |
| [Agent with shared context](#agent-with-shared-context) | `const analyst = ctx.agent("reviewer")` |
| [Prompt step](#prompt-step) | `await analyst.prompt(...)` |
| [Structured output](#structured-output) | `await analyst.prompt(..., Schema)` |
| [Artifact write](#artifact-write) | `await analyst.prompt(..., { writes: "file.md" })` |
| [Parallel jobs](#parallel-jobs) | `await ctx.parallel([...])` |
| [Nested workflow](#nested-workflow) | `await ctx.run(plan, input)` |
| [Eval gate](#eval-gate) | `await ctx.evals("build")` |
| [Run a TypeScript sigil](#run-a-typescript-sigil) | `sigil run-sigil --repo . --file workflow.ts` |

#### Agent with shared context

An agent object is one model context. Reuse the same variable when later prompt steps should build on earlier ones.

```ts
await using analyst = ctx.agent("reviewer");
```

#### Prompt step

A prompt step is one call on that agent object. Use plain text output when the next step only needs prose.

```ts
const summary = await analyst.prompt("Summarize the likely problem in one paragraph.");
```

#### Structured output

Use structured output when later workflow steps branch on a machine-readable result instead of free text.

```ts
const classification = await analyst.prompt("Classify the issue.", Schema);
```

#### Artifact write

Use an artifact write when the output should become a named file, not just a string returned from the prompt.

```ts
await analyst.prompt("Write a minimal reproduction script.", {
  writes: "repro.sh",
  minBytes: 1,
});
```

#### Parallel jobs

Parallel jobs run independent work together. Each branch should create its own agent so context does not leak across branches.

```ts
const [risk, tests] = await ctx.parallel([
  async () => ctx.agent("reviewer").prompt("Review risk."),
  async () => ctx.agent("reviewer").prompt("Review missing tests."),
]);
```

#### Eval gate

An eval gate runs a named deterministic check from config, such as `build` or `test`.

```ts
const gate = await ctx.evals("build");
```

#### Run a TypeScript sigil

Use `run-sigil` for saved or temporary TypeScript sigils. It loads an optional JSON input object, adds the resolved `repo`, creates a context, launches a detached worker, and returns the run handle.

```sh
sigil validate-sigil workflow.ts
sigil run-sigil --repo /path/to/repo --file workflow.ts --input input.json --run-dir /path/to/repo/.sigil/runs/custom-workflow
```

Runs default to durable persistence. Sigil rejects temporary repositories, workflow files, inputs, outputs, and run directories unless the command explicitly selects `--persistence ephemeral`. Built-in and custom workflows keep their artifacts beneath an isolated run in the ignored `<repo>/.sigil/runs/` directory. Nested workflows inherit that run instead of selecting another artifact root.

For a dedicated nested-workflow example, see [examples/05-nested-workflow.ts](./examples/05-nested-workflow.ts). For a fuller workflow that combines structured branching, parallel jobs, artifact handoff, an eval gate, and nested shipped workflows together, see [examples/06-issue-workflow.ts](./examples/06-issue-workflow.ts).

#### Nested workflow

A nested workflow is one sigil calling another through the same run context. That lets you reuse shipped workflows or your own custom workflows without dropping down to file-path handoffs or a second orchestration layer.

```ts
import { implement, plan, sigil } from "sigil";

export const buildIssueChange = sigil(
  "build-issue-change",
  async (ctx, input: { repo: string; issue: string; brief?: string }) => {
    const planned = await ctx.run(plan, {
      repo: input.repo,
      intent: input.issue,
      brief: input.brief,
    });

    if (!planned.valid) {
      return { ok: false, stage: "plan", issues: planned.issues };
    }

    const implemented = await ctx.run(implement, {
      repo: input.repo,
      taskFile: planned.taskFile,
    });

    return {
      ok: !implemented.reviewBlocking && implemented.failedTasks.length === 0,
      stage: "implement",
      branch: implemented.branch,
      issues: implemented.issues,
    };
  },
);
```

`ctx.run(...)` keeps the composition typed and explicit. The child workflow receives the current context instead of starting a separate orchestration universe.

### Learn the surface in order

If you want to write your own workflows, read the examples in order:

1. [Minimal custom sigil](./examples/01-custom-sigil-minimal.ts)
2. [Parallel analysis](./examples/02-parallel-analysis.ts)
3. [Plan plus implement](./examples/03-plan-implement.ts)
4. [Custom delivery policy](./examples/04-custom-delivery.ts)
5. [Nested workflow](./examples/05-nested-workflow.ts)
6. [Full issue workflow](./examples/06-issue-workflow.ts)

There is also an [examples guide](./examples/README.md) that explains what each file teaches and why the example files import from the local source tree while the README snippets import from the public `sigil` entrypoint.

### When to write a custom sigil

Write a custom sigil when the task is large enough to benefit from orchestration and the built-in workflows do not already match it. A custom sigil may be saved for reuse or kept in the repository's ignored `.sigil/runs/` directory for one request.

Typical cases:

- different models should analyze the same problem from different angles
- several analyses should run in parallel, then be synthesized into one result
- one agent should investigate sequentially, filling its context before producing a plan or report
- a creative model should generate options and a verification-oriented model should test them
- the next step should branch on a structured classification or decision made during the run
- the result should pass deterministic checks before you trust it

Examples:

- **Architecture decision workflow**: run several model perspectives in parallel, synthesize one recommendation, then verify that it names affected systems, tradeoffs, and risks.
- **Incident investigation workflow**: analyze logs, propose likely causes, generate a repro or repair brief, then require a deterministic artifact or passing check before closing the loop.
- **Research workflow**: send agents to search web, docs, and repo sources from different angles, then synthesize what is known, uncertain, and decision-relevant.

Use the built-in workflows when the shipped path already matches your need. Write a custom sigil when your task needs runtime branching, model specialization, synthesis, sequential deepening, or task-specific policy.

| Use this | When |
| --- | --- |
| Built-in sigil | The shipped path already matches your task |
| Saved custom sigil | The workflow will be repeated, shared, or maintained |
| Temporary custom sigil | The workflow is substantial and custom to one request |
| Static YAML workflow | The topology is fixed and the readable stage/job/step structure is the main value |

Run saved or temporary TypeScript sigils with `validate-sigil` and `run-sigil` so they receive the normal Sigil context and artifact root:

```sh
env -u CLAUDECODE sigil validate-sigil ./my-workflow.ts
env -u CLAUDECODE sigil run-sigil --repo /path/to/repo --file ./my-workflow.ts --input input.json --out result.json --run-dir /path/to/repo/.sigil/runs/custom-workflow
```

Direct Bun execution is a lower-level development option for scripts that create their own context. `run-sigil` owns detached execution and records its PID, status, events, logs, artifacts, result, and error in the durable run directory.

### Static YAML workflows

Use YAML when the workflow topology is fixed ahead of time and you want to see the workflow structure directly as stages, jobs, and steps.

A YAML workflow uses an ADO-inspired shape:

- **stage**: a sequential phase
- **job**: a parallel or isolated unit of work
- **step**: one workflow action inside a job

A YAML job is exactly one of these:

- an **agent job** with `agent:` and `prompt` steps
- a **deterministic job** with `script` or `sh` steps

It cannot be both. Agent jobs may also use `eval` and `run`. Deterministic jobs may also use `eval` and `run`.

Use an agent by config name when the repo's `sigil.config.json` already defines it:

```yaml
agent: reviewer
```

Or set the provider, model, and optional effort inline for a self-contained workflow:

```yaml
agent:
  provider: codex
  model: gpt-5.5
  effort: medium
```

Validate a YAML workflow before running it:

```sh
sigil validate-workflow --repo <dir> <workflow.yaml>
```

Run a static YAML workflow against a target repository:

```sh
sigil run-workflow --repo <dir> --file <workflow.yaml>
```

Example:

```yaml
name: triage-issue
description: Classify an incoming issue, then fix it or spec it
stages:
  - id: understand
    jobs:
      - id: analysis
        agent: reviewer
        steps:
          - id: reproduce
            prompt: |
              Read the issue below and summarize the likely problem in one paragraph.
              {{ issue }}
          - id: classify
            prompt: |
              Based on what you found, reply with exactly one token: BUG or FEATURE
            output:
              enum: [BUG, FEATURE]
          - id: write-repro
            prompt: Write a minimal reproduction script for what you found.
            writes: repro.sh
            minBytes: 1
  - id: act
    jobs:
      - id: fix
        agent: implementer
        condition: $analysis.classify.output == 'BUG'
        steps:
          - id: implement
            prompt: Fix the bug. The reproduction is at $artifacts/repro.sh and must pass.
          - id: gate
            eval: build
      - id: spec
        agent: implementer
        condition: $analysis.classify.output == 'FEATURE'
        steps:
          - id: write-spec
            prompt: Write an implementation spec for this feature request.
            writes: spec.md
            minBytes: 1
```

See [examples/07-triage-workflow.yaml](./examples/07-triage-workflow.yaml) for the same workflow as a standalone file. See [SIGIL_USAGE.md](./SIGIL_USAGE.md) for the YAML validator constraints that are easy to trip over.

## Shipped workflows

The public TypeScript entrypoint exports these async functions and their input/result types:

- `softwareChange`: the primary single-change workflow. It plans, implements, verifies/reviews, and returns combined evidence without publishing.
- `plan`: turns an intent and optional brief into a typed task graph for a target repo.
- `implement`: applies a task graph, runs configured gates, commits work, runs review, and returns the branch and PR body for a delivery caller.
- `review`: reviews the diff against a base branch and can run an autofix pass for actionable findings.
- `probePlan`: runs sandboxed probes and produces a typed task graph for implementation.
- `breakdown`: turns a mission into an ordered backlog file.
- `dispatch`: calls `softwareChange` for backlog items, then owns publish, optional merge, and base verification policy.
- `refactor`: applies one bounded structural change with protected-path checks and independent reviews.
- `migrate`: runs checkpointed repository migration items through `refactor` from an external run directory.

### Compose shipped workflows

Use shipped workflows directly when the standard flow is almost right but your product needs its own policy.

**Run the standard single-change workflow:**

```ts
import { softwareChange } from "sigil";

export async function buildChange(repo: string, intent: string) {
  return softwareChange({ repo, intent });
}
```

**Plan and build one change with the stage boundary exposed:**

See [examples/03-plan-implement.ts](./examples/03-plan-implement.ts) for a richer version that carries `brief` and `outFile` through planning and returns explicit stage state.

```ts
import { implement, plan } from "sigil";

export async function buildChange(repo: string, intent: string) {
  const planned = await plan({ repo, intent });
  if (!planned.valid) return { ok: false, stage: "plan", issues: planned.issues };

  const implemented = await implement({ repo, taskFile: planned.taskFile });
  return {
    ok: !implemented.reviewBlocking && implemented.failedTasks.length === 0,
    stage: "implement",
    branch: implemented.branch,
    prBody: implemented.prBody,
    issues: implemented.issues,
  };
}
```

**Add your own delivery policy:**

See [examples/04-custom-delivery.ts](./examples/04-custom-delivery.ts) for a stronger policy wrapper that decides whether to publish and shapes the PR title.

```ts
import { implement, plan, publish } from "sigil";

export async function shipWhenClean(repo: string, intent: string, base = "main") {
  const planned = await plan({ repo, intent });
  if (!planned.valid) return { shipped: false, issues: planned.issues };

  const implemented = await implement({ repo, taskFile: planned.taskFile });
  if (implemented.reviewBlocking || implemented.failedTasks.length) {
    return { shipped: false, implemented };
  }

  const published = await publish(repo, {
    branch: implemented.branch,
    title: implemented.branch,
    body: implemented.prBody,
    base,
  });
  return { shipped: published.pr?.ok === true, implemented, published };
}
```

**Run parallel analysis:**

See [examples/02-parallel-analysis.ts](./examples/02-parallel-analysis.ts) for a version that returns structured reports from each parallel branch and then joins them into one recommendation.

```ts
import { sigil } from "sigil";

export const analyzeChange = sigil(
  "analyze-change",
  async (ctx, input: { repo: string; diff: string }) => {
    const [risk, tests] = await ctx.parallel([
      async () => {
        await using reviewer = ctx.agent("reviewer");
        return reviewer.prompt(`Review this diff for product and code risk.\n\n${input.diff}`);
      },
      async () => {
        await using tester = ctx.agent("reviewer");
        return tester.prompt(`Review this diff for missing tests.\n\n${input.diff}`);
      },
    ]);

    return { risk, tests, issues: ctx.issues };
  },
);
```

**Compose a higher-level workflow:**

```ts
import { breakdown, dispatch } from "sigil";

export async function shipMission(repo: string, mission: string) {
  const backlog = await breakdown({ repo, mission });
  if (!backlog.valid) return { ok: false, stage: "breakdown", issues: backlog.issues };

  return dispatch({ repo, backlogFile: backlog.backlogFile, deliveryPolicy: "mergeWhenGreen" });
}
```

The built-in single-change path is `softwareChange`: planning, implementation, verification/review, and evidence construction in one local workflow that does not publish. The stage callables stay available for advanced composition, and `dispatch` is the layer that adds backlog delivery policy.

Dispatch processes items serially in dependency order. Use `integrationBranch` when item PRs should accumulate on a feature branch and the complete mission should end as one unmerged PR to main. Use `mergeWhenGreen` when every verified item should merge directly to main.

The boundary stays explicit: planning, implementation, review, publishing, and merging remain separate composable steps. Callers choose the policy that connects them.

## Authoring modes

Use **TypeScript** when the workflow needs runtime adaptation: dynamic batching, runtime branching, sequential investigation, model selection, iterative repair, or composition with other sigils. This is the most expressive way to author Sigil workflows because the workflow is ordinary code.

Use **YAML** when the workflow topology is fixed ahead of time and readability as stages, jobs, and steps is the main value. YAML can still choose agents, run parallel jobs, use prompt steps, write artifacts, run deterministic checks, and apply simple conditions. The tradeoff is that YAML is less suited to workflows that discover their own shape while running.

## Config

Each target repo needs a [`sigil.config.json`](./sigil.config.json). `loadConfig()` searches upward from the target repo path and validates these sections against `SigilConfig` in [src/config.ts](./src/config.ts):

- `agents` (`codex`, `claude`, or `copilot` provider/model bindings)
- `evals`
- `workspace`
- `plan`
- `implement`
- `review`

## Evals

Every configured eval command must be non-interactive. It must never prompt. Set `CI=1`, pass `--yes` or `--no-interactive` flags where tools support them, and disable analytics or first-run prompts. A command that prompts can hang the gate forever.

If a sigil references an eval that is not defined in `evals`, Sigil skips it.

## Learn the model in more depth

If you want the deeper model behind the examples and workflow surfaces, see:

- [SIGIL_USAGE.md](./SIGIL_USAGE.md), the primary usage reference
- [LLMs, agents, agent SDKs, and workflows](./docs/explanation/llms-agents-and-workflows.md)
- [Workflow shapes: static and dynamic](./docs/explanation/workflow-shapes.md)
- [Primitives and composition](./docs/explanation/primitives-and-composition.md)
- [Prompt patterns](./docs/explanation/prompt-patterns.md)
- [Workflow patterns](./docs/explanation/workflow-patterns.md)
- [Ephemeral sigils](./docs/how-to/ephemeral-sigils.md)

## Development

Run `bun run typecheck` and `bun test`. Use `bun run preview:readme` to preview README rendering locally while iterating on product docs or assets.
