---
name: sigil
description: "Route Sigil work by user intent, accepted state, and the unfinished state transition. Use when a request may benefit from a built-in workflow, static YAML workflow, custom TypeScript Sigil, or specialized dispatch, refactor, or migration operation."
---

# Sigil router

Use this skill to decide whether Sigil adds value and, when it does, select the narrowest workflow that owns the unfinished transition.

Read the routing section of [SIGIL_USAGE.md](../../SIGIL_USAGE.md) before selecting a built-in surface. Read the [workflow pattern catalog](../../docs/explanation/workflow-patterns.md) only when custom orchestration remains a candidate.

## Decide whether orchestration helps

Use Sigil when agents, typed handoffs, artifacts, deterministic gates, repair, delivery policy, or repeatable workflow structure materially improve the result.

Answer or edit directly when the request is a quick factual check, short explanation, or simple one-shot change that does not need orchestration.

## Inspect accepted state

Before choosing a workflow, inspect the state the user already accepts:

- active or explicitly referenced Markdown plan;
- task graph;
- probe result;
- existing diff or branch change;
- backlog;
- dispatch checkpoint and active item branch;
- refactor or migration run state;
- completed gates and reviews.

Do not repeat planning, implementation, review, or delivery work merely because a higher-level workflow normally includes it.

When the user asks to run `software-change` after developing or approving a
Markdown plan, verify that plan file exists and pass its complete contents
through `--brief`. Resolve an omitted filename against the active or most
recently accepted plan artifact in the conversation. The command's concise
`--intent` labels the change; it does not replace the plan. Ask which plan to
use only when more than one artifact remains genuinely plausible. A validated
task graph is different accepted state and uses `--task-file` instead.

## Route the unfinished transition

- **One ordinary software change with no accepted task graph**: use
  `software-change`; pass an accepted Markdown plan through `--brief` when one
  exists.
- **One ordinary software change requiring detached execution or a custom authority boundary**: use a temporary TypeScript Sigil that composes `softwareChange`; do not promote it to dispatch unless delivery policy is required.
- **Planning is the requested output**: use `plan`.
- **The correct change requires safe behavioral experiments**: use `probe`, then reuse its task graph through `software-change --task-file` or `implement` according to the requested boundary.
- **Accepted task graph**: skip planning. Prefer `software-change --task-file`; use `implement` when the implementation stage itself is the requested boundary.
- **Existing diff or branch change**: use `review` without replanning or reimplementation.
- **Backlog delivery requiring publication, merge, delivery-base verification, or resumable delivery state**: use the `sigil-dispatch` skill. A one-item backlog is appropriate only when those dispatch-owned effects are required.
- **One bounded behavior-preserving structural change**: use the `sigil-refactor` skill.
- **Repository-wide structural migration**: use the `sigil-migration` skill.
- **Fixed custom topology**: use a YAML workflow with `validate-workflow` and `run-workflow`.
- **Dynamic custom orchestration**: select or adapt a pattern, then use the `sigil-authoring` skill.

Use `SIGIL_USAGE.md` for exact commands, flags, persistence, artifact layout, and the distinction between library results and CLI-owned external effects. Do not reproduce that reference here.

## Authority and effects

Identify whether the selected path may edit, commit, publish, merge, deploy, or perform another external effect. The user, caller, or configured policy grants authority. Deterministic code must enforce that boundary.

Do not add an approval checkpoint to low-risk local work unless the user requests it. Require explicit authority before publishing, merging, deployment, destructive changes, access changes, or other consequential external effects.

## Operating rules

- Use subscription or local account authentication rather than provider API keys for ordinary Sigil runs.
- Clear an inherited Claude session marker when Sigil launches nested agents from another agent shell.
- Treat task-graph acceptance criteria as outcomes rather than stale mechanism mandates.
- Use configured workspace bootstrap and gates rather than inventing untracked preparation steps.
- Report the useful result and material failures. Do not dump raw run artifacts unless the user asks.
