---
name: sigil-plan
description: "Build an approval-first planning bundle for one Sigil change, show the proposed intent and any open questions to the user, and only run `sigil plan` after approval. Use when the user wants a grounded plan for this repository rather than an immediate implementation run."
---

# sigil-plan

Use this skill when the user wants a plan for a change in this repository and the plan should be grounded in a small durable bundle before `sigil plan` runs. Do not use it for direct implementation-only work when a validated task graph already exists.

## Outcome

Create a four-file bundle that captures the approved planning input for this repository:

```text
bundle/
  intent.md
  evidence.md
  scope.md
  summary.json
```

Then pause and show the user:

- the proposed intent
- target files
- main constraints
- any open questions that still affect the plan

Run `sigil plan` only after the user approves the bundle or answers the open questions.

## Bundle contents

### `intent.md`

Write a short first-person restatement of the user's goal, constraints, non-goals, and success condition.

Keep it specific to the current request. This is the human-readable planning intent, not a transcript.

### `evidence.md`

Combine the grounded material that should shape planning:

- verified facts
- the most relevant repository files and why they matter
- prior findings or prior guides the user explicitly wants considered
- contradictions that planning must resolve

Treat docs as claims until checked against source or observed behavior.

### `scope.md`

Define:

- target files
- likely non-target files
- repo-specific execution guidance
- validation expectations

For this repository, keep these default guardrails unless the user says otherwise:

- do not push
- do not revert unrelated local changes
- prefer explicit run directories for custom TypeScript sigils
- treat `implement` as requiring a clean tree or a temp clone/worktree

### `summary.json`

Write a compact machine-readable index with:

- `goal`
- `canonical_target` when there is one
- `targets`
- `non_targets`
- `evidence_files`
- `repo_files`
- `constraints`

Keep it short. It is for routing and prompt assembly, not prose.

## Repository defaults

When the user does not specify a narrower set, treat these as the main truth sources for planning documentation or workflow changes in this repo:

- `README.md`
- `ARCHITECTURE.md`
- `docs/how-to/ephemeral-sigils.md`
- `examples/README.md`
- `src/help.ts`
- `src/cli.ts`
- `src/sigil-runner.ts`
- `src/context.ts`
- `src/yaml/validate.ts`
- `man/sigil.1`
- `sigil.config.json`

If the user explicitly points at prior evidence files, include them in `evidence.md` and in `summary.json`.

## Approval-first flow

1. Read the request and identify the concrete goal.
2. Gather and verify the small set of repo files that actually matter.
3. Write `intent.md`, `evidence.md`, `scope.md`, and `summary.json`.
4. Present the proposed intent, target files, constraints, and open questions to the user.
5. Wait for approval.
6. After approval, run:

```sh
env -u CLAUDECODE sigil plan --repo <repo> --intent "<approved intent>" --brief <bundle-derived-brief> [--out <file>]
```

The brief should be synthesized from the bundle, not from raw chat history.

## Open questions

Do not store unresolved questions inside the bundle by default. Show them to the user at the approval checkpoint instead.

Only move them into the planning input after the user resolves them or explicitly approves proceeding with uncertainty.

## When to auto-run planning

Do not auto-run `sigil plan` before approval. This skill is approval-first by design.

If the user has already approved the intent and scope in the same session, proceed directly to `sigil plan` with the bundle-derived brief.

## Notes for this repository

- If planning is likely to lead quickly into `implement`, consider whether the eventual implementation step should run in a temp clone or worktree to protect the live working tree.
- If prior probe runs or run artifacts exist, summarize the verified findings in `evidence.md` rather than feeding all raw probe files directly into the planner.
- Prefer industry-standard names in the bundle and plan output. Avoid house metaphors.
