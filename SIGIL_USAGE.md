# Sigil usage guide

This is the single usage guide for Sigil. Use `README.md` for the product overview and example ladder. Use this file when you need the operator contract: which surface to choose, which command to run, what the command means, and how to inspect a run.

## What Sigil is

**Agent workflows you can read, reason about, and verify.**

Build composable agent workflows in ordinary TypeScript, with explicit control flow, typed state, and deterministic verification.

Sigil is a workflow runtime over tool-using agent runtimes. An LLM supplies reasoning and generation. An agent runtime supplies tools and session continuity. A configured agent role resolves to a provider/runtime, model, and reasoning-effort binding. `ctx.agent(...)` creates a live agent session from that binding.

A workflow owns control flow and a state transition. Agents supply bounded judgment inside workflow operations. Users, callers, or configured policy grant authority; deterministic code enforces authority boundaries and owns persistence, gates, checkpoints, and effect execution.

A TypeScript Sigil is a workflow implemented with the `sigil()` API. TypeScript supplies ordinary control flow. Sigil supplies the context object, agent creation, artifact helpers, eval gates, shell helpers, parallel execution, and nested workflow calls. A YAML workflow is the declarative surface for a fixed topology. See [LLMs, agent runtimes, agents, and workflows](./docs/explanation/llms-agents-and-workflows.md) for the complete glossary.

TypeScript workflows are intended to read as the process they execute, not to imitate YAML. Use ordinary branches and loops for dynamic behavior, one named statement per conceptual step, and typed returns between steps. Use agents for judgment; use deterministic code for control, verification, persistence, and external effects.

## Choose the right surface

Reuse accepted artifacts and verified state. Invoke the narrowest workflow that owns the unfinished transition.

| Accepted state or intent | Next surface | Main commands |
| --- | --- | --- |
| One software change with no accepted task graph | Run the complete local single-change workflow. Use `plan` alone only when the planning boundary is the requested output. | `sigil software-change`, `sigil plan` |
| Uncertain change that requires safe behavioral experiments | Produce an evidence-backed task graph in a sandbox, then reuse it downstream. | `sigil probe`, then `sigil software-change --task-file` or `sigil implement` |
| Accepted task graph | Skip planning. Use the unified workflow unless the implementation stage itself is the desired boundary. | `sigil software-change --task-file`, `sigil implement` |
| Existing diff or branch change | Review the current diff without repeating planning or implementation. | `sigil review` |
| Large mission without an accepted backlog | Produce the backlog, then deliver it according to explicit policy. | `sigil breakdown`, `sigil dispatch` |
| Accepted or partially delivered backlog | Start or resume dependency-ordered delivery. | `sigil dispatch` |
| One behavior-preserving structural boundary | Run one verified structural transformation. | `sigil refactor` |
| Repository-wide structural target and backlog | Run a checkpointed migration program. | `sigil migrate` |
| Fixed custom stage, job, and step topology | Use a YAML workflow. | `sigil validate-workflow`, `sigil run-workflow` |
| Dynamic custom orchestration | Select a workflow pattern, then author a TypeScript Sigil. | `sigil validate-sigil`, `sigil run-sigil` |

Do not use Sigil for quick factual checks, simple edits, or one-turn answers that do not need orchestration.

## Install and setup

Install from the release archive:

```sh
gh api repos/markovchainmontecarlo/sigil/contents/scripts/install.sh --jq .content | base64 -d | sh
```

The installer writes the `sigil` launcher, installs the library and production dependencies, refreshes bundled skills, and installs the man page when present. Upgrade by re-running the installer.

Sigil uses local or subscription authentication for Codex and Claude. The public `claude` provider can use the local Claude CLI PTY or the Claude Agent SDK through its selected local access profile. Run Claude and complete its login flow before using the CLI transport. Do not expose credential values in Sigil configuration or diagnostics.

Initialize a target repository:

```sh
sigil setup --dir /path/to/repo
```

Then edit `sigil.config.json` in that repository. Setup also adds `/.sigil/runs/` to `.gitignore` so durable local execution state never dirties the worktree. Sigil resolves config by searching upward from the target repo path.

## Configuration

A representative config shape is:

```json
{
  "agents": {
    "explorer": { "provider": "codex", "model": "<model-name>", "effort": "medium" },
    "implementer": { "provider": "claude", "model": "<claude-model>", "effort": "medium" },
    "reviewer": { "provider": "claude", "model": "<claude-sdk-model>", "effort": "medium" }
  },
  "evals": {
    "build": "<non-interactive build command>",
    "test": "<non-interactive test command>"
  },
  "workspace": {
    "bootstrap": "bun install --frozen-lockfile"
  },
  "context": [
    { "path": "ARCHITECTURE.md", "update": true },
    { "path": "README.md", "update": false }
  ],
  "plan": {
    "planners": ["explorer", "implementer"],
    "synthesizer": "explorer"
  },
  "implement": {
    "coder": "implementer",
    "batchSize": 5,
    "repairLimit": 3,
    "branchPrefix": "sigil/",
    "baseBranch": "main"
  },
  "review": {
    "reviewer": "reviewer",
    "followUpReviews": 0
  }
}
```

Config sections:

- `agents`: named provider and model bindings. Supported providers are `codex`, `claude`, and `copilot`. Claude transport selection is local rather than a separate project provider. When `effort` is omitted, the binding defaults to `medium`.
- `evals`: named shell commands. Commands run under the target repo and must be non-interactive. Missing eval names are skipped.
- `workspace.bootstrap`: optional deterministic preparation command run before implementation or refactor baseline gates. It must leave tracked files unchanged.
- `context`: repo-relative files loaded at run start. Paths cannot escape the repo.
- `plan`: planner agent names and one synthesizer agent name.
- `implement`: coder agent, batch size, repair limit, branch prefix, base branch, and optional test report settings.
- `review`: reviewer agent and the number of fresh reviews allowed after repair. `followUpReviews` defaults to `0`; repairs still run configured verification gates.

Configured context is orientation, not proof. Verify important claims against source or observed behavior before relying on them. `update: true` marks a drift-controlled write-back target. `update: false` marks read-only context unless the task explicitly declares that file as an output. Missing configured context files are skipped and reported in the rendered context block.

Use `discover-env` when provider availability or authentication is uncertain:

```sh
sigil discover-env --repo /path/to/repo
```

The report distinguishes configured bindings, Claude SDK credential presence, Claude PTY executable availability, and Claude PTY authentication. Executable availability means only that Sigil can find and execute Claude; it does not prove that Claude is logged in. Claude owns and stores its local subscription authentication, and Sigil reports that state as not verified rather than inspecting it.

For the Claude CLI transport, executable selection is deterministic: `SIGIL_CLAUDE_PTY_BIN` takes precedence, then `CLAUDE_BIN`, then the first executable named `claude` on `PATH`. The child process receives a filtered environment that removes inherited agent-session markers and provider credential variables. This keeps the Claude CLI on its own local login and prevents a parent agent shell from supplying credentials or session identity to the child.

When running Sigil from inside another agent shell, clear the nested Claude session marker:

```sh
env -u CLAUDECODE sigil <command> ...
```

For the complete provider boundary, see the [configuration reference](./docs/reference/configuration.md), [provider profile reference](./docs/reference/provider-profiles.md), [profile setup how-to](./docs/how-to/configure-provider-profiles.md), and [provider routing explanation](./docs/explanation/provider-routing.md).

## CLI reference

Run `sigil --help`, `sigil <command> --help`, or `man sigil` for the installed reference. CLI help and command parsers are the executable authority for supported syntax and exit behavior; this guide is the canonical human-facing explanation of how to choose and operate those commands.

| Command | What it does | Exit code `0` means |
| --- | --- | --- |
| `sigil dashboard [--host 127.0.0.1] [--port <number>] [--root <dir>]...` | Serve a read-only live dashboard for discoverable local runs. | The dashboard shut down normally. |
| `sigil setup [--dir <repo>] [--force]` | Write the default repo config. | The config was written. |
| `sigil discover-env [--repo <dir>]` | Print a read-only environment report. | The report was printed. |
| `sigil migrate --repo <dir> --target <file> --backlog <file> --run-dir <dir>` | Apply a dependency-ordered repository migration with commit checkpoints. | Every item, final review, build, and test passed. |
| `sigil refactor --repo <dir> --intent <text> [--brief <file>] [--focus <path>]... [--protected-path <path>]...` | Apply one behavior-preserving structural change from advisory focus paths while respecting protected paths. | Final build and test gates passed without issues. |
| `sigil probe --repo <dir> --intent <text> [--brief <file>] [--out <file>] [--max-probes <n>]` | Run sandboxed probes, synthesize findings, and produce a task graph. | The produced task graph is valid and the target working tree is preserved. |
| `sigil plan --repo <dir> --intent <text> [--brief <file>] [--out <file>]` | Plan one change into a task graph. | The produced task graph is valid. |
| `sigil software-change --repo <dir> --intent <text> [--brief <file>] [--out <file>] [--task-file <file>] [--branch <name>] [--instructions <file>]` | Run the unified local single-change workflow without publishing. | The workflow result is valid and reports no issues. |
| `sigil validate [--repo <dir>] <task-file>` | Validate a task graph. | The validation error array is empty. |
| `sigil implement --repo <dir> --task-file <file> [--branch <name>] [--instructions <file>]` | Apply a task graph, review it, then push and open a PR. | PR creation succeeded, review is not blocking, and no failed tasks or issues were reported. |
| `sigil review --repo <dir> --base <ref> [--no-autofix] [--context <text>]` | Review the current diff. | There are no unresolved high findings and no issues. |
| `sigil breakdown --repo <dir> --mission <text> [--out <file>]` | Turn a mission into a backlog. | The produced backlog is valid. |
| `sigil dispatch --repo <dir> --backlog <file> --policy mergeWhenGreen\|integrationBranch --run-dir <dir>` | Start durable backlog delivery through main or an accumulating integration branch. | Dispatch finished without stopping. |
| `sigil dispatch --resume <dir>` | Resume the recorded operation after repository and process ownership checks. | Dispatch finished without stopping. |
| `sigil profile <action>` | Manage local Codex and Claude profiles, inspect stored policy, and observe current eligibility. | Profile operation completed. |
| `sigil validate-workflow [--repo <dir>] <workflow-file>` | Validate a static YAML workflow. | The workflow error array is empty. |
| `sigil run-workflow --repo <dir> --file <workflow-file>` | Run a static YAML workflow inline. | The workflow completed without recorded issues. |
| `sigil validate-sigil <workflow.ts>` | Validate a TypeScript sigil without running it. | The workflow imports and has a callable export. |
| `sigil run-sigil --repo <dir> --file <workflow.ts> [--input <input.json>] [--out <result.json>] [--run-dir <dir>] [--persistence durable|ephemeral]` | Launch a detached TypeScript sigil. | The detached worker launched successfully. |

## Built-in software workflows

Use `software-change` for the normal single-change path. It plans from an intent, implements the typed task graph, runs configured verification and review through the implementation stage, and returns combined evidence. It does not push, open a pull request, merge, or apply a dispatch policy.

```sh
env -u CLAUDECODE sigil software-change \
  --repo /path/to/repo \
  --intent "<change intent>" \
  --out /path/to/repo/.sigil/runs/task-graph.json
```

Use `--brief <file>` when planning needs longer context. When a Markdown plan
is already the accepted description of the change, pass the complete plan as
the brief even if the immediate run request states only a short intent. The
intent names the change; it does not replace accepted planning context. Use
`--instructions <file>` for implementation-only guidance. Use
`--task-file <file>` to skip planning and run the same unified workflow from an
existing typed task graph.

### Single changes, detached execution, and dispatch

Workflow selection and execution mode are separate decisions. `software-change`
owns one code change. `dispatch` owns backlog delivery policy. `run-sigil` launches
a composed workflow as a detached durable run; it does not turn that workflow into
a dispatch.

| Starting point and desired result | Surface |
|---|---|
| Intent or Markdown plan for one verified local change | `software-change --brief` |
| Accepted task graph for one verified local change | `software-change --task-file` |
| One change requiring detached execution or a custom authority boundary | A temporary TypeScript Sigil that calls `ctx.run(softwareChange, ...)`, launched with `run-sigil` |
| One backlog item requiring dispatch-owned publication, merge, delivery-base verification, or delivery recovery | A one-item backlog passed to `dispatch` |
| Several dependent deliverables | `breakdown`, then `dispatch` |

A Markdown implementation plan is planning context, not the task graph contract.
Pass it through `--brief`; `software-change` still translates it into a validated
task graph. A validated task graph is accepted implementation state. Pass it
through `--task-file` to skip planning.

Dispatch accepts a one-item backlog, but use that shape only when dispatch must own
publication, merging, delivery-base verification, or resumable delivery state. Do
not create a one-item backlog merely to combine planning and implementation;
`software-change` already owns that transition.

When one change needs detached execution without dispatch delivery, compose the
built-in workflow in a temporary TypeScript Sigil:

```ts
import { sigil, softwareChange } from "sigil";

export default sigil("detached-software-change", (ctx, input: {
  repo: string;
  intent: string;
  brief?: string;
}) => ctx.run(softwareChange, input));
```

Launch that wrapper with `run-sigil` and a durable run directory. The wrapper adds
detached execution, logs, artifacts, and a caller-owned authority boundary while
preserving `software-change` semantics.

Use the stage commands when the stage boundary is the object you need to inspect or compose. `plan` writes a task graph. `implement` consumes a task graph, requires a clean target working tree, owns one local implementation branch, runs configured gates and review, returns a PR body, and the CLI command publishes that branch. `review` can also be run by itself against an existing diff.

```sh
env -u CLAUDECODE sigil plan --repo /path/to/repo --intent "<change intent>" --out /path/to/repo/.sigil/runs/task-graph.json
env -u CLAUDECODE sigil validate --repo /path/to/repo /path/to/repo/.sigil/runs/task-graph.json
env -u CLAUDECODE sigil implement --repo /path/to/repo --task-file /path/to/repo/.sigil/runs/task-graph.json
env -u CLAUDECODE sigil review --repo /path/to/repo --base main
```

When the right change is unclear until the tool is exercised, run probe planning first. `probe` asks agents for falsifiable hypotheses, runs generated commands in a sandbox clone, writes evidence and findings under the active run, checks that tracked project files are preserved, and produces the same task graph contract consumed by `implement` and `software-change --task-file`.

```sh
env -u CLAUDECODE sigil probe --repo /path/to/repo --intent "<usage or product improvement intent>" --out /path/to/repo/.sigil/runs/task-graph.json
env -u CLAUDECODE sigil software-change --repo /path/to/repo --intent "<same intent>" --task-file /path/to/repo/.sigil/runs/task-graph.json
```

For a larger mission with delivery policy, use backlog decomposition and dispatch. `breakdown` writes the backlog contract. Start dispatch with a durable `--run-dir`, then use `--resume` after interruption. Resume validates the repository, backlog, policy, delivery base, active branch, and process ownership before allowing mutation. A live dispatcher blocks resume. For an abandoned child, resume terminates the recorded process group, escalates from `SIGTERM` to `SIGKILL` when required, confirms that its descendants are gone, and then removes the lease. Completed items are not replayed, and expected in-progress repair edits are preserved rather than reset. Use `integrationBranch` to accumulate item pull requests away from main. The default final action opens one final pull request. `--final-action mergeWhenGreen` also merges that pull request, and `--production-gate <name>` verifies the configured deployment gate afterward.

Provider profiles are user-local routing configuration. Use `profile list` for safe registry summaries, `profile inspect <selector>` for one stored policy and state record, and `profile status` for current eligibility and provider evidence. Selectors are provider-qualified, such as `codex:pro` or `claude:pro`; a bare name works only when globally unique. Human output is the default and `--json` returns distinct versioned records. Neither form exposes provider-local paths, credential-source names or values, environment data, or account identity.

Codex subscription admission subtracts active reserved headroom and the new assignment quantum from observed capacity, then refuses assignments that would cross `--reserve-floor`. `profile next` records only a bounded one-shot selection and cannot bypass disabled state, circuits, rearm requirements, capacity floors, or metered budgets. `profile prime` is an explicit Codex subscription operation. Claude returns a typed unsupported result, and read operations and dispatch never prime profiles. Metered profiles require explicit routing mode, bounded admission, and a hard per-operation limit.

Agent attempts have total, idle, and cancellation-settlement bounds. When a total or idle deadline expires, Sigil requests provider cancellation and waits through the configured cancellation grace. Cleanup must settle before a retry starts. If a provider ignores cancellation, Sigil returns the classified timeout without starting overlapping work; a later provider rejection remains observed rather than becoming an unhandled rejection.

Claude PTY creates one Claude session identity per Sigil agent and starts a new PTY process for each turn, resuming that session after the first turn. Claude's transcript is the authority for matching the submitted prompt to a completed assistant turn; terminal output contributes only startup classification and payload-free provider progress. Closing or cancelling a turn terminates its owned process group and publishes the stopped lifecycle state before another attempt may start. Recovery owns total and idle deadlines and may retry only after that cleanup settles.

After logging in with the local Claude CLI, run the opt-in smoke check from a Sigil source checkout:

```sh
env -u CLAUDECODE bun run smoke:claude-subscription
```

```sh
env -u CLAUDECODE sigil breakdown --repo /path/to/repo --mission "<mission>" --out /path/to/repo/.sigil/runs/backlog.json
env -u CLAUDECODE sigil dispatch \
  --repo /path/to/repo \
  --backlog /path/to/repo/.sigil/runs/backlog.json \
  --policy integrationBranch \
  --integration-branch feature/mission \
  --run-dir $HOME/.sigil/runs/dispatch/mission
```

For repository migration, define a stable target and dependency-ordered backlog outside the target worktree, then run `migrate` on a clean named branch. Each backlog item runs the `refactor` workflow, commits only verified results, snapshots evidence under the run directory, and advances checkpoint state atomically. Repository-wide final repairs are also committed and checkpointed. Resume with the same command only when the target, backlog, branch, and checkpoint HEAD still match.

```sh
env -u CLAUDECODE sigil migrate \
  --repo /path/to/worktree \
  --target $HOME/.sigil/runs/migrations/project/target.md \
  --backlog $HOME/.sigil/runs/migrations/project/backlog.json \
  --run-dir $HOME/.sigil/runs/migrations/project/run
```

Every migration item attempt owns its events, status, plan, reviews, result or error, and failed diff. Recoverable model operations retry independently in fresh contexts. Each distinct gate, protected-path violation, and blocking review finding has its own repair history. Failed attempts preserve their evidence before the migration worktree returns to its preceding verified checkpoint. Resume can reconcile a verified item commit when execution stopped before the state write.

## Task graph contract

The task graph is the seam between `plan` and `implement`. It has `contractVersion`, `project`, optional `goal`, and ordered `tasks`. Each task has `id`, `title`, `summary`, `dependencies`, `acceptanceCriteria`, `diagrams`, and `files`.

Acceptance criteria should describe observable outcomes, not mechanism mandates. `implement` should satisfy the intended behavior even when a prescribed mechanism is stale. Task order is dependency-driven. `implement` skips a task when one of its dependencies has already failed.

## Static YAML workflows

Use YAML when the topology is fixed and readability as stages, jobs, and steps is the main value:

```sh
env -u CLAUDECODE sigil validate-workflow --repo /path/to/repo workflow.yaml
env -u CLAUDECODE sigil run-workflow --repo /path/to/repo --file workflow.yaml
```

A YAML job is either an agent job or a deterministic job:

- Agent jobs have `agent:` and can use prompt steps, eval steps, and run steps.
- Deterministic jobs omit `agent:` and can use `script`, `sh`, eval steps, and run steps.
- Agent jobs cannot contain `script` or `sh` steps.
- Prompt steps require an agent job.

Reference rules that matter in practice:

- Job conditions can only reference outputs from earlier stages. A condition in one job cannot depend on another job from the same stage.
- Step references can use outputs and artifacts that are already available.
- For cross-stage data flow, prefer explicit jobs and reference job step outputs from later stages.

Prefer TypeScript when the workflow discovers its own shape while running.

## TypeScript Sigils

Use a TypeScript Sigil for maintained dynamic workflows and substantial one-off workflows. A workflow file must export either a default callable or a named `workflow` callable.

Validate the export before launching long agent work:

```sh
env -u CLAUDECODE sigil validate-sigil workflow.ts
```

Launch with durable defaults. Input, output, and run-directory flags are optional:

```sh
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json
```

`run-sigil` validates the launch inputs, starts a detached worker, and returns the run handle. The worker writes status, events, logs, artifacts, results, and errors into the run directory. The CLI-resolved `--repo` value is authoritative. If `input.json` contains a `repo` field, the runner replaces it with the resolved command-line repository path. `--input` must be a JSON object.

Run persistence defaults to `durable`. Durable runs reject repositories, workflow files, inputs, outputs, and run directories beneath operating-system temporary storage. When `--run-dir` is omitted, Sigil creates an isolated run under `<repo>/.sigil/runs/`. `sigil setup` adds that directory to `.gitignore`, and Sigil also registers the path in the repository's local exclude file. Built-in and nested workflows inherit the active run artifact root.

Use `--persistence ephemeral` only when every run input and artifact is intentionally disposable. Ephemeral mode permits operating-system temporary directories and makes their loss an accepted outcome.

When `--run-dir` is supplied, agent and workflow artifacts are written under `<run-dir>/artifacts/`. Detached-run status, events, logs, results, and errors are written into the same durable run directory. Use this only when a stable explicit path materially helps the user or another system:

```sh
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json \
  --out result.json \
  --run-dir /path/to/repo/.sigil/runs/custom-workflow
```

Use `ctx.artifacts.write`, `ctx.artifacts.read`, and `ctx.artifacts.path` for files owned by the run. Use project file writes only when the workflow is intentionally changing the target repository.

Inside a TypeScript Sigil, the main context and agent surfaces are:

| Need | Surface |
| --- | --- |
| Open an agent by config name or inline binding | `ctx.agent(...)` or `ctx.withAgent(...)` |
| Preserve one model context across sequential prompt steps | Reuse one agent object |
| Keep independent work isolated | Use separate agents inside `ctx.parallel([...])` |
| Tolerate partial failure | `ctx.parallelSettled([...])` |
| Branch on machine-readable output | `agent.prompt(prompt, zodSchema)` |
| Ask an agent to create a run artifact | `agent.prompt(prompt, { writes: "file.md" })` |
| Write deterministic run artifacts | `ctx.artifacts.write(name, contents)` |
| Run a configured gate | `ctx.evals("build")` |
| Run deterministic local logic | `ctx.sh(...)` |
| Include configured context in custom prompts | `await ctx.renderContextBlock()` |
| Compose shipped workflows in the same context | `ctx.run(softwareChange, input)` or another exported workflow |
| Create an explicit child artifact namespace | `ctx.fork(...)` |
| Record a non-fatal issue | `ctx.issue(detail)` |

Use config-backed role names such as `explorer`, `implementer`, and `reviewer` when practical. If an inline binding is necessary, use medium reasoning effort unless the user explicitly requests high effort for that run.

## Temporary TypeScript Sigils

Use a temporary TypeScript Sigil for one substantial request when dynamic orchestration adds value and no built-in workflow already owns the required transition. Select a shape from the [workflow pattern catalog](./docs/explanation/workflow-patterns.md), then follow [Create and run a temporary TypeScript Sigil](./docs/how-to/temporary-typescript-sigil.md).

The durable runner defaults remain the same as for maintained TypeScript Sigils. When `--run-dir` is omitted, Sigil creates an isolated ignored run directory beneath `<repo>/.sigil/runs/`. Input, output, and explicit run-directory flags are optional controls, not required ceremony.

Use operating-system temporary storage only with `--persistence ephemeral` when loss of the workflow, inputs, evidence, logs, and result is acceptable.

Promote a temporary TypeScript Sigil to maintained project code only when it will be reused, reviewed, tested, or documented as a stable capability.

## Troubleshooting

- Missing config: run `sigil setup` in the target repo or pass the correct `--repo` path.
- Unknown agent: check that the name appears under `agents` and that `plan`, `implement`, `review`, or YAML jobs reference the same name.
- Hanging eval: make eval commands non-interactive. Add CI flags, disable first-run prompts, and avoid commands that wait for input.
- Dirty working tree: `implement` requires a clean target working tree before it starts. Commit, stash, or move unrelated changes before implementation.
- TypeScript Sigil import failure: run `sigil validate-sigil workflow.ts`; check that imports resolve and the file exports a default callable or named `workflow` function.
- Invalid input JSON: `--input` must point to a JSON object. The CLI-supplied `--repo` value wins over any `repo` field in the input file.
- Durable run refused: move the repository, workflow, inputs, outputs, and run directory out of operating-system temporary storage. Use `--persistence ephemeral` only when loss is acceptable.
- Artifacts not where expected: durable custom runs default to `<repo>/.sigil/runs/`; with `--run-dir`, artifacts are under `<run-dir>/artifacts/`.

## Further reading

- `README.md`: product overview and example ladder.
- `ARCHITECTURE.md`: runtime architecture and system contracts.
- `docs/how-to/temporary-typescript-sigil.md`: how to create and run a temporary TypeScript Sigil.
- `docs/explanation/`: conceptual background and workflow patterns.
- `examples/`: runnable authoring patterns.
- `man/sigil.1`: installed CLI manual source.
