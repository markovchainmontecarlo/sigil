---
name: sigil-authoring
description: "Author and run temporary or maintained TypeScript Sigils when dynamic custom orchestration is more appropriate than a built-in workflow or fixed YAML workflow."
---

# TypeScript Sigil authoring

Use this skill after the Sigil router has determined that a dynamic custom workflow is justified. Prefer a built-in workflow when it already owns the required transition, and prefer YAML when the complete stage, job, and step topology is known before the run.

Read the [workflow pattern catalog](../../docs/explanation/workflow-patterns.md), choose the smallest fitting pattern, and then consult [primitives and composition](../../docs/explanation/primitives-and-composition.md) for the TypeScript surface. Use a different shape only when the request has a concrete control-flow need the catalog does not cover.

## Define the boundary

Before authoring, establish:

- desired outcome;
- typed or human-readable output;
- accepted input and existing artifacts;
- repository files or external resources that may change;
- protected resources that must not change;
- external effects and who authorizes them;
- deterministic verification;
- partial-failure and stopping behavior.

Classify the workflow as analysis-only, artifact-producing, repository-changing, or externally acting. That classification determines its authority and verification needs.

## Author the workflow

1. Adapt the selected pattern to the request.
2. Reuse built-in workflows for planning, implementation, review, backlog delivery, refactor, or migration instead of recreating their behavior.
3. Write one exported TypeScript Sigil with stable input and result types when useful.
4. Keep prompts and model bindings outside workflow bodies when the workflow is maintained.
5. Use durable runner defaults. Supply explicit input, output, or run paths only when stable paths materially help the user or another system.
6. Validate the workflow before launching model work.
7. Run it through `run-sigil`, which launches detached by default.
8. Inspect the typed result, material artifacts, recorded issues, and failed gates before reporting completion.

Use [SIGIL_USAGE.md](../../SIGIL_USAGE.md) for exact validation, launch, persistence, status, and artifact commands.

## TypeScript surface

- `ctx.agent(...)` or `ctx.withAgent(...)` creates a live agent session from a role or inline binding.
- Reuse one agent object for sequential context.
- Use separate agents inside `ctx.parallel(...)` for independent work.
- Use `ctx.parallelSettled(...)` when useful partial results should survive branch failure.
- Use structured output when deterministic code must branch on a result.
- Use agent writes or `ctx.artifacts` for named workflow artifacts.
- Use `ctx.evals(...)` and `ctx.sh(...)` for deterministic checks and local logic.
- Use `ctx.run(...)` to invoke a nested workflow in the same context.
- Use `ctx.fork(...)` only when the child needs an explicit artifact namespace.
- Use `ctx.issue(...)` for non-fatal issues returned with the result.

Use configured role names where practical. Inline bindings default to medium reasoning effort unless the user explicitly requests high effort for that run.

## Autonomy inside protected boundaries

Constrain outcomes, protected resources, external effects, and verification. Leave dependency discovery and bounded execution open to model judgment. Focus paths are advisory; protected paths are authoritative.

Route actual failed evaluations and protected-resource violations through bounded repair. Do not classify justified dependency discovery as failure.

## Temporary versus maintained

Keep a TypeScript Sigil temporary when it serves one request. Save it as a maintained repository workflow when it will be reused, reviewed, tested, or documented as a stable capability.

A maintained workflow needs stable input and result types, stable prompt bindings, tests, and a concise explanation of when to use it.
