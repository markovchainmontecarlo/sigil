---
name: sigil
description: "Route Sigil work by user intent, accepted state, and the unfinished state transition. Use when a request may benefit from a built-in workflow, static YAML workflow, custom TypeScript Sigil, or specialized dispatch, refactor, or migration operation."
---

# Sigil router

Decide whether Sigil adds value, establish the confirmed handoff, then select the narrowest workflow that owns the unfinished transition.

## Decide whether orchestration helps

Use Sigil when agents, typed handoffs, artifacts, deterministic gates, repair, delivery policy, or repeatable workflow structure materially improve the result.

Answer or edit directly when the request is a quick factual check, short explanation, or simple one-shot change that does not need orchestration.

## Establish the confirmed handoff

Before planning or implementation, inspect the conversation and repository, then write `brief.md` beneath the ignored run directory using the [brief reference](./references/brief.md), show its complete contents, and wait for confirmation or correction. The confirmation establishes the outcome, accepted decisions, and effects boundary. It is not a checkpoint before every internal repair.

Use **AI-assisted development** when the current assistant turns confirmed requirements or a settled Markdown plan into a validated task graph. Sigil then implements that graph without planning again.

Use **agentic development** when Sigil should investigate, plan, replan, probe uncertain behavior, decompose a mission, or run unattended delivery. In this mode a Sigil workflow owns the transition from the confirmed brief to a validated task graph or backlog.

These are entry paths, not runtime flags. Both paths converge on the same task-graph contract and implementation workflow.

For AI-assisted development, turn the agreed requirements and repository evidence into a task graph with `sigil-task-graph`. Confirm cohesive scope, map file responsibilities and state flow, record architecture, constraints, and non-goals, and name produced and consumed interfaces between tasks. Keep acceptance observable and verification focused. Validate and repair the graph, show a concise task summary when approval is still needed, and run `implement` when authorized. Keep the result local unless publication is explicitly authorized.

Treat “use Sigil” or “use the Sigil skill” as a request to establish the brief and route the unfinished transition. Do not treat it as implicit authority for agentic planning, publication, merging, or deployment.

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

When an active Markdown plan exists, verify that the file exists and read it in full. Resolve an omitted filename against the active or most recently accepted plan in the conversation. If more than one plan could be meant, ask which one.

After the brief is confirmed, present exactly these routes:

- **Replan and implement**: pass the confirmed brief and complete plan through `software-change --brief`. Sigil may reconsider implementation choices and correct repository claims, but it must preserve the confirmed outcome, decisions, constraints, and non-goals.
- **Convert and implement locally**: use `sigil-task-graph` to translate the confirmed brief and complete plan directly, validate the graph, and pass both the graph and confirmed brief to local implementation without another planning round.

Do not infer this choice. A validated task graph is accepted implementation state and uses `implement` directly.

## Route the unfinished transition

- **Bounded change already discussed with the current assistant**: confirm the brief, use the `sigil-task-graph` skill to author and validate the graph, then run `implement` when authorized.
- **Active Markdown plan**: confirm the brief, then ask whether to replan and implement or convert and implement locally.
- **User explicitly requests Sigil-owned planning for one change**: use `software-change`; pass relevant context through `--brief`. When the planning input does not exist yet, author it with the `sigil-brief` skill first.
- **One ordinary software change requiring detached execution or a custom authority boundary**: use a temporary TypeScript Sigil that composes `softwareChange`; do not promote it to dispatch unless delivery policy is required.
- **Planning is the requested output**: use `plan`.
- **The correct change requires safe behavioral experiments**: use `probe`, then reuse its task graph through `software-change --task-file` or `implement` according to the requested boundary.
- **Accepted task graph**: skip planning and use `implement`. Use `software-change --task-file` only when its combined result shape or composition boundary is specifically needed.
- **Existing diff or branch change**: use the real `review` workflow without replanning or reimplementation. There is no separate review skill. For a read-only request, run `review` with `autofix: false`. When the developer explicitly requests review and repair, disclose that the workflow may edit the existing checkout and run `review` with `autofix: true`.
- **Backlog delivery requiring publication, merge, delivery-base verification, or resumable delivery state**: use the `sigil-dispatch` skill. A one-item backlog is appropriate only when those dispatch-owned effects are required.
- **One bounded behavior-preserving structural change**: use the `sigil-refactor` skill.
- **Repository-wide structural migration**: use the `sigil-migration` skill.
- **Fixed custom topology**: use a YAML workflow with `validate-workflow` and `run-workflow`.
- **Dynamic custom orchestration**: select or adapt a pattern, then use the `sigil-authoring` skill.

## Detailed guidance

| Need | Source |
| --- | --- |
| First local change | [First change with an AI assistant](../../docs/tutorials/first-change-with-ai-assistant.md) |
| Task-graph creation | [Task-graph authoring](../../docs/how-to/author-task-graph-with-ai-assistant.md) |
| Task-graph fields and validation | [Task-graph reference](../../docs/reference/task-graph.md) |
| Local implementation and publication | [Implement an accepted task graph](../../docs/how-to/implement-accepted-task-graph.md) |
| Sigil-owned planning and probing | [Agentic single change](../../docs/tutorials/agentic-single-change.md) |
| Multi-change delivery | [Program delivery](../../docs/tutorials/agentic-program-delivery.md) and `sigil-dispatch` |
| Custom orchestration | [Workflow patterns](../../docs/explanation/workflow-patterns.md) and `sigil-authoring` |
| Application integration | [Server application](../../docs/how-to/server-application.md) |
| Commands, flags, and exit behavior | [Sigil usage](../../SIGIL_USAGE.md) |
| Architecture and terminology | [Architecture](../../ARCHITECTURE.md) and [LLMs, agents, and workflows](../../docs/explanation/llms-agents-and-workflows.md) |

## Authority and effects

Identify whether the selected path may edit, commit, publish, merge, deploy, or perform another external effect. The user, caller, or configured policy grants authority. Deterministic code must enforce that boundary.

Do not add an approval checkpoint to low-risk local work unless the user requests it. Require explicit authority before publishing, merging, deployment, destructive changes, access changes, or other consequential external effects.

## Operating rules

- Use subscription or local account authentication rather than provider API keys for ordinary Sigil runs.
- Clear an inherited Claude session marker when Sigil launches nested agents from another agent shell.
- Treat task-graph acceptance criteria as outcomes rather than stale mechanism mandates.
- Treat task file entries as evidence-backed starting points, not a restrictive allowlist.
- Use configured workspace bootstrap and gates rather than inventing untracked preparation steps.
- Report the useful result and material failures. Do not dump raw run artifacts unless the user asks.
