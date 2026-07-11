---
name: sigil
description: "Route Sigil work to the right surface: built-in SWE flows, direct task-graph implementation, static YAML workflows, temporary TypeScript sigils, or saved reusable sigils. Use when a user asks to plan, implement, review, decompose, dispatch, validate, run, or author Sigil workflows against a repository."
---

# sigil

Use this skill to choose the right Sigil path. Sigil is useful when the task benefits from agents, gates, artifacts, task graphs, delivery policy, or repeatable workflow structure. It is too heavy for quick factual checks, short answers, or simple one-shot edits that do not need orchestration.

## Route the request

- **Hypothesis-driven usage or behavior audit**: run `probe -> implement` when the right change requires sandboxed experiments, edge-case checks, or falsifying assumptions before planning.
- **One-PR SWE change, not already planned**: run `plan -> implement`. Use `review` alone when the user only wants a diff reviewed.
- **Large SWE mission needing several PRs**: run `breakdown -> dispatch`. Use `integrationBranch` to accumulate automatically merged item PRs behind one unmerged final PR. Use `mergeWhenGreen` only when each verified item should merge directly to main.
- **Work already understood**: write a task graph directly, run `sigil validate [--repo <dir>] <task-file>`, then run `sigil implement --repo <dir> --task-file <task-file>`. Do not invoke `plan` just to convert known work into JSON.
- **Fixed topology workflow**: use static YAML with `validate-workflow` and `run-workflow` when stages, jobs, and steps are known before the run.
- **Dynamic or substantial custom workflow**: use a TypeScript sigil. For temporary or saved TypeScript workflows, use the `sigil-authoring` skill.
- **Reusable workflow requested**: save a TypeScript sigil in the repo with a clear input/output shape and examples. Use `validate-sigil` before recommending it.

## Commands to remember

- `sigil setup [--dir <repo>] [--force]`
- `sigil probe --repo <dir> --intent <text> [--brief <file>] [--out <file>] [--max-probes <n>]`
- `sigil plan --repo <dir> --intent <text> [--brief <file>] [--out <file>]`
- `sigil validate [--repo <dir>] <task-file>`
- `sigil implement --repo <dir> --task-file <file> [--branch <name>] [--instructions <file>]`
- `sigil review --repo <dir> --base <ref> [--no-autofix] [--context <text>]`
- `sigil breakdown --repo <dir> --mission <text> [--out <file>]`
- `sigil dispatch --repo <dir> --backlog <file> --policy mergeWhenGreen|integrationBranch [--integration-branch <branch>]`
- `sigil validate-workflow [--repo <dir>] <workflow-file>`
- `sigil run-workflow --repo <dir> --file <workflow-file>`
- `sigil validate-sigil <workflow.ts>`
- `sigil run-sigil --repo <dir> --file <workflow.ts> [--input <input.json>] [--out <result.json>] [--run-dir <dir>]`
- `sigil discover-env [--repo <dir>]`

## Operating rules

- Use subscription or local account auth. Do not set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for Sigil runs.
- When running Sigil from inside another agent shell, prefix commands with `env -u CLAUDECODE` so nested agents do not inherit the wrong session marker.
- Built-in `implement` requires a clean target working tree and owns one branch and one PR.
- Acceptance criteria in task graphs are outcomes, not mechanism mandates.
- Artifacts are outside the target tree by default. With `run-sigil --run-dir`, TypeScript sigil artifacts land under that run directory's `artifacts/` directory.

## References

Use these when deeper explanation is needed, but do not copy them into normal answers:

- `docs/explanation/llms-agents-and-workflows.md`
- `docs/explanation/workflow-shapes.md`
- `docs/explanation/primitives-and-composition.md`
- `docs/explanation/prompt-patterns.md`
- `docs/explanation/workflow-patterns.md`
- `docs/how-to/ephemeral-sigils.md`
