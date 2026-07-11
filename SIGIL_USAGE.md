# Sigil usage guide

This is the single usage guide for Sigil. Use `README.md` for the product overview and example ladder. Use this file when you need the operator contract: which surface to choose, which command to run, what the command means, and how to inspect a run.

## What Sigil is

Sigil is a workflow layer over tool-using agents. Agents read files, edit files, run tools, and keep model context. Sigil owns the deterministic structure around that work: control flow, agent selection, parallel jobs, artifacts, eval gates, issue accumulation, nested workflows, and delivery policy.

A sigil is a plain async TypeScript workflow with typed input and output. TypeScript supplies ordinary control flow. Sigil supplies the context object, agent creation, artifact helpers, eval gates, shell helpers, parallel execution, and calls into nested sigils.

## Choose the right surface

Use the smallest surface that fits the work:

| Surface | Use when | Main commands |
| --- | --- | --- |
| Unified single-change workflow | One local software change should be planned, implemented, verified/reviewed, and summarized without publishing. | `sigil software-change` |
| Advanced single-change stages | You need to inspect or reuse the stage boundary between planning, implementation, and review. | `sigil plan`, `sigil implement`, `sigil review` |
| Probe planning | The right change is unclear until Sigil actively tests behavior in a sandbox. | `sigil probe`, then `sigil implement` or `sigil software-change --task-file` |
| Direct task graph | The work is already understood and only needs the implementation runner. | `sigil validate`, `sigil implement` |
| Backlog delivery | A mission needs several dependent deliverables with publish or merge policy. | `sigil breakdown`, `sigil dispatch` |
| Repository migration | A target architecture should be applied through checkpointed refactor items. | `sigil migrate` |
| Static YAML workflow | The stage, job, and step topology is known before the run. | `sigil validate-workflow`, `sigil run-workflow` |
| TypeScript sigil | The workflow needs runtime branching, iteration, parallel analysis, synthesis, artifact handoff, gates, or nested workflow composition. | `sigil validate-sigil`, `sigil run-sigil` |

Do not use Sigil for quick factual checks, simple edits, or one-turn answers that do not need orchestration.

## Install and setup

Install from the release archive:

```sh
gh api repos/markovchainmontecarlo/sigil/contents/scripts/install.sh --jq .content | base64 -d | sh
```

The installer writes the `sigil` launcher, installs the library and production dependencies, refreshes bundled skills, and installs the man page when present. Upgrade by re-running the installer.

Sigil uses local or subscription authentication for Codex and Claude. Do not use provider API keys as the ordinary setup path.

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
    "implementer": { "provider": "codex", "model": "<model-name>", "effort": "medium" },
    "reviewer": { "provider": "codex", "model": "<model-name>", "effort": "medium" }
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
    "reviewer": "reviewer"
  }
}
```

Config sections:

- `agents`: named provider and model bindings. Supported providers are `codex`, `claude`, and `copilot`.
- `evals`: named shell commands. Commands run under the target repo and must be non-interactive. Missing eval names are skipped.
- `workspace.bootstrap`: optional deterministic preparation command run before implementation or refactor baseline gates. It must leave tracked files unchanged.
- `context`: repo-relative files loaded at run start. Paths cannot escape the repo.
- `plan`: planner agent names and one synthesizer agent name.
- `implement`: coder agent, batch size, repair limit, branch prefix, base branch, and optional test report settings.
- `review`: reviewer agent name.

Configured context is orientation, not proof. Verify important claims against source or observed behavior before relying on them. `update: true` marks a drift-controlled write-back target. `update: false` marks read-only context unless the task explicitly declares that file as an output. Missing configured context files are skipped and reported in the rendered context block.

Use `discover-env` when provider availability or authentication is uncertain:

```sh
sigil discover-env --repo /path/to/repo
```

When running Sigil from inside another agent shell, clear the nested Claude session marker:

```sh
env -u CLAUDECODE sigil <command> ...
```

## CLI reference

Run `sigil --help`, `sigil <command> --help`, or `man sigil` for the installed reference.

| Command | What it does | Exit code `0` means |
| --- | --- | --- |
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
| `sigil dispatch --repo <dir> --backlog <file> --policy mergeWhenGreen\|integrationBranch [--integration-branch <branch>] [--final-action openPullRequest\|mergeWhenGreen] [--production-gate <name>]` | Deliver a backlog in dependency order through main or an accumulating integration branch. | Dispatch finished without stopping. |
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

Use `--brief <file>` when planning needs longer context. Use `--instructions <file>` for implementation-only guidance. Use `--task-file <file>` to skip planning and run the same unified workflow from an existing typed task graph.

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

For a larger mission with delivery policy, use backlog decomposition and dispatch. `breakdown` writes the backlog contract. `dispatch` consumes that backlog, calls `softwareChange` for each deliverable item, then owns repair convergence, publishing, merge, and delivery-base verification. Its run artifact directory contains `dispatch-state.json`; rerun with the same run context to resume the active branch and stage. Pull-request creation is idempotent, merge waits for green checks, and delivered items are not replayed. Use `integrationBranch` to accumulate item PRs away from main. The default final action opens one final PR. `--final-action mergeWhenGreen` also merges that PR, and `--production-gate <name>` verifies the configured deployment gate afterward. Use the direct `mergeWhenGreen` policy only when every verified item should merge directly to main.

```sh
env -u CLAUDECODE sigil breakdown --repo /path/to/repo --mission "<mission>" --out /path/to/repo/.sigil/runs/backlog.json
env -u CLAUDECODE sigil dispatch \
  --repo /path/to/repo \
  --backlog /path/to/repo/.sigil/runs/backlog.json \
  --policy integrationBranch \
  --integration-branch feature/mission
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

## TypeScript sigils

Use TypeScript for saved reusable workflows and substantial one-off workflows. A workflow file must export either a default callable or a named `workflow` callable.

Validate the export before launching long agent work:

```sh
env -u CLAUDECODE sigil validate-sigil workflow.ts
```

Run with an explicit result file and run directory:

```sh
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json \
  --out result.json \
  --run-dir /path/to/repo/.sigil/runs/custom-workflow
```

`run-sigil` validates the launch inputs, starts a detached worker, and returns the run handle. The worker writes status, events, logs, artifacts, results, and errors into the run directory. The CLI-resolved `--repo` value is authoritative. If `input.json` contains a `repo` field, the runner replaces it with the resolved command-line repository path. `--input` must be a JSON object.

Run persistence defaults to `durable`. Durable runs reject repositories, workflow files, inputs, outputs, and run directories beneath operating-system temporary storage. When `--run-dir` is omitted, Sigil creates an isolated run under `<repo>/.sigil/runs/`. `sigil setup` adds that directory to `.gitignore`, and Sigil also registers the path in the repository's local exclude file. Built-in and nested workflows inherit the active run artifact root.

Use `--persistence ephemeral` only when every run input and artifact is intentionally disposable. Ephemeral mode permits operating-system temporary directories and makes their loss an accepted outcome.

When `--run-dir` is supplied, agent and workflow artifacts are written under `<run-dir>/artifacts/`. Detached-run status, events, logs, results, and errors are written into the same durable run directory:

```sh
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json \
  --out result.json \
  --run-dir /path/to/repo/.sigil/runs/custom-workflow
```

Use `ctx.artifacts.write`, `ctx.artifacts.read`, and `ctx.artifacts.path` for files owned by the run. Use project file writes only when the workflow is intentionally changing the target repository.

Inside a TypeScript sigil, the main context and agent surfaces are:

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
| Compose shipped workflows | `ctx.run(plan, input)`, `ctx.run(implement, input)`, or another exported sigil |
| Record a non-fatal issue | `ctx.issue(detail)` |

Use config-backed role names such as `explorer`, `implementer`, and `reviewer` when practical. If an inline binding is necessary, use medium reasoning effort unless the user explicitly requests high effort for that run.

## Ephemeral TypeScript sigils

An ephemeral sigil is a temporary TypeScript sigil for one substantial request. Use one when the task benefits from orchestration: repo exploration followed by synthesis, independent parallel analysis, structured classification followed by routing, artifact creation with review, or deterministic checks around generated work.

Do not use an ephemeral sigil when a normal assistant answer is enough, a built-in workflow already fits, or the workflow should clearly be saved and maintained.

Use the repository's ignored run directory when the workflow, evidence, or logs may be inspected later:

```text
<repo>/.sigil/runs/<topic>/
  workflow.ts
  input.json
  artifacts/
  result.json
  run.log
```

Use operating-system temporary storage only for a disposable run whose loss is acceptable:

```text
/tmp/sigil-<topic>/
  workflow.ts
  input.json
  artifacts/
  result.json
  run.log
```

Before writing `workflow.ts`, decide the goal, final output shape, sequential steps, independent parallel analyses, agent roles, artifacts, deterministic gates, partial-failure behavior, caveats, and next action. Use the smallest workflow that earns the orchestration cost.

Minimal template:

```ts
import { sigil } from "sigil";

export default sigil(
  "ephemeral-investigation",
  async (ctx, input: { repo: string; question: string }) => {
    const context = await ctx.renderContextBlock();

    const report = await ctx.withAgent("explorer", (agent) =>
      agent.prompt([
        "Investigate this question. Read relevant repo files before deciding.",
        context,
        `Question: ${input.question}`,
      ].filter(Boolean).join("\n\n")),
    );

    const reportPath = await ctx.artifacts.write("report.md", report);

    return {
      report,
      artifacts: { report: reportPath },
      issues: ctx.issues,
    };
  },
);
```

Run it:

```sh
cd /tmp/sigil-<topic>
env -u CLAUDECODE sigil validate-sigil workflow.ts
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json \
  --out result.json \
  --persistence ephemeral \
  --run-dir .
```

After the run, read `result.json`, inspect important artifacts, and skim `run.log` for failures. Report the useful answer, workflow shape, artifact paths when they matter, failed gates, recorded issues, caveats, and the next action. Do not paste every raw artifact into chat unless the user asks for it.

Promote an ephemeral sigil to a saved repo workflow only when it will be reused, reviewed, tested, or documented as a stable project capability.

## Troubleshooting

- Missing config: run `sigil setup` in the target repo or pass the correct `--repo` path.
- Unknown agent: check that the name appears under `agents` and that `plan`, `implement`, `review`, or YAML jobs reference the same name.
- Hanging eval: make eval commands non-interactive. Add CI flags, disable first-run prompts, and avoid commands that wait for input.
- Dirty working tree: `implement` requires a clean target working tree before it starts. Commit, stash, or move unrelated changes before implementation.
- TypeScript sigil import failure: run `sigil validate-sigil workflow.ts`; check that imports resolve and the file exports a default callable or named `workflow` function.
- Invalid input JSON: `--input` must point to a JSON object. The CLI-supplied `--repo` value wins over any `repo` field in the input file.
- Durable run refused: move the repository, workflow, inputs, outputs, and run directory out of operating-system temporary storage. Use `--persistence ephemeral` only when loss is acceptable.
- Artifacts not where expected: durable custom runs default to `<repo>/.sigil/runs/`; with `--run-dir`, artifacts are under `<run-dir>/artifacts/`.

## Further reading

- `README.md`: product overview and example ladder.
- `ARCHITECTURE.md`: runtime architecture and system contracts.
- `docs/how-to/ephemeral-sigils.md`: assistant-facing ephemeral sigil workflow.
- `docs/explanation/`: conceptual background and workflow patterns.
- `examples/`: runnable authoring patterns.
- `man/sigil.1`: installed CLI manual source.
