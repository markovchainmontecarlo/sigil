# Examples

Read these in order.

1. [01-custom-sigil-minimal.ts](./01-custom-sigil-minimal.ts): the first step up from the README example; add structured output on top of the same minimal workflow shape.
2. [02-parallel-analysis.ts](./02-parallel-analysis.ts): parallel jobs with separate agent context, then a joined recommendation step.
3. [03-software-change.ts](./03-software-change.ts): use the unified `softwareChange` workflow for one complete local change and surface its stage result.
4. [04-custom-delivery.ts](./04-custom-delivery.ts): keep delivery policy outside the workflow work and decide when to publish.
5. [05-nested-workflow.ts](./05-nested-workflow.ts): call a shipped workflow through `ctx.run(...)` and return its typed result from the shared workflow context.
6. [06-issue-workflow.ts](./06-issue-workflow.ts): add structured branching, artifact handoff, parallel jobs, evals, and nested workflows together.
7. [07-triage-workflow.yaml](./07-triage-workflow.yaml): the first static YAML workflow, using stages, jobs, steps, prompt actions, artifact writes, conditions, and eval gates.
8. [08-temporary-sigil.ts](./08-temporary-sigil.ts): a temporary TypeScript Sigil meant for `validate-sigil` and `run-sigil`, with multiple agents, independent parallel analysis, synthesis, artifacts, a gate, and a JSON result.
9. [09-architecture-documentation.ts](./09-architecture-documentation.ts): a persistent lead agent drafts and iteratively improves root `ARCHITECTURE.md` through two repository-driven explorer fan-outs and final verification.

These files are authoring patterns, not required locations. Every maintained TypeScript example imports from the public `sigil` package. Production server applications should place long runs behind an application-owned queue and Node worker rather than copy the local detached-run shape. See [Run Sigil from a server application](../docs/how-to/server-application.md).
