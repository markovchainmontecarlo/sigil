---
name: sigil
description: "Route Sigil work by user intent, accepted state, and the unfinished state transition. Use when a request may benefit from a built-in workflow, static YAML workflow, custom TypeScript Sigil, or specialized dispatch, refactor, or migration operation."
---

# Sigil router

Decide whether Sigil adds value, choose between AI-assisted development and agentic development, then select the narrowest workflow that owns the unfinished transition.

## Decide whether orchestration helps

Use Sigil when agents, typed handoffs, artifacts, deterministic gates, repair, delivery policy, or repeatable workflow structure materially improve the result.

Answer or edit directly when the request is a quick factual check, short explanation, or simple one-shot change that does not need orchestration.

## Choose the development mode

Use **AI-assisted development** by default when the developer is already discussing a bounded change with a capable code assistant. The current assistant turns the agreed requirements or Markdown plan into a validated task graph. Sigil then implements that graph without planning again.

Use **agentic development** when the user explicitly asks Sigil to investigate, plan, replan, probe uncertain behavior, decompose a mission, or run unattended delivery. In this mode a Sigil workflow owns the transition from intent or brief to a validated task graph or backlog.

These are entry paths, not runtime flags. Both paths converge on the same task-graph contract and implementation workflow.

Treat “use Sigil” or “use the Sigil skill” as a request to route the work, not as a request for agentic planning. Default to AI-assisted development when the current assistant already has the agreed requirements or active plan. Ask who should perform planning only when that choice is genuinely unclear.

For AI-assisted development, turn the agreed requirements and repository evidence into a task graph with `sigil-task-graph`. Validate and repair the graph, show a concise task summary when approval is still needed, and run `implement` when authorized. Keep the result local unless publication is explicitly authorized.

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

When the user asks to implement an active Markdown plan, verify that the plan file exists and read it in full. Resolve an omitted filename against the active or most recently accepted plan in the conversation. If more than one plan could be meant, ask which one. In AI-assisted development, use the plan, agreed requirements, and verified repository evidence to author the task graph directly. Validate the graph, repair validation errors, and pass it to `implement`. Do not invoke Sigil planning merely because a plan file exists.

Pass a Markdown plan through `software-change --brief` only when the user explicitly asks Sigil to plan or replan agentically. A validated task graph is accepted implementation state and uses `--task-file` or `implement` directly.

## Route the unfinished transition

- **Bounded change already discussed with the current assistant**: use the `sigil-task-graph` skill to author and validate the graph, then run `implement` when authorized.
- **Active Markdown plan in AI-assisted development**: read the complete plan and translate it directly into a validated task graph. Do not run `plan` or `software-change --brief`.
- **User explicitly requests Sigil-owned planning for one change**: use `software-change`; pass relevant context through `--brief`.
- **One ordinary software change requiring detached execution or a custom authority boundary**: use a temporary TypeScript Sigil that composes `softwareChange`; do not promote it to dispatch unless delivery policy is required.
- **Planning is the requested output**: use `plan`.
- **The correct change requires safe behavioral experiments**: use `probe`, then reuse its task graph through `software-change --task-file` or `implement` according to the requested boundary.
- **Accepted task graph**: skip planning and use `implement`. Use `software-change --task-file` only when its combined result shape or composition boundary is specifically needed.
- **Existing diff or branch change**: use `review` without replanning or reimplementation.
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
