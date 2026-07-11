---
name: sigil-authoring
description: "Create and run temporary or saved TypeScript sigils for substantial custom workflows. Use when an assistant should write workflow.ts and optional input.json, validate with validate-sigil, execute with run-sigil, inspect artifacts, and report the useful result without making the user learn the Sigil API."
---

# sigil-authoring

Use this skill when the right Sigil route is a TypeScript sigil: the workflow is dynamic, needs several model roles, benefits from sequential context or independent parallel analysis, branches on structured output, writes artifacts, runs gates, or wraps delivery policy. Do not use it for quick answers or when a built-in SWE flow already fits.

## Autonomy inside protected boundaries

Constrain outcomes, invariants, protected resources, external effects, and verification. Leave plans, dependency discovery, file selection, implementation, and bounded repair open to model judgment.

Treat focus paths as advisory starting points, never as a complete allowlist. A Sigil may follow any repository dependency justified by its intent unless the caller explicitly protects that path. Record paths discovered beyond focus with their justification. Route protected-path changes and actual failed evaluations through bounded repair; do not classify ordinary dependency discovery as failure.

## Authoring workflow

1. Decide the workflow shape: sequential context, independent parallel analysis, synthesis, structured output, artifacts, gates, shell/script helpers, configured context, and any delivery policy.
2. Create a durable ignored run directory at `<repo>/.sigil/runs/<topic>/` with `workflow.ts`, optional `input.json`, `result.json`, `run.log`, and `artifacts/`. Use operating-system temporary storage only when the entire run is disposable.
3. Write `workflow.ts` as a normal exported TypeScript sigil. `create a sigil` is assistant knowledge, not a built-in Sigil command.
4. Keep user/request data in `input.json` when useful. The runner supplies the resolved `repo` field.
5. Run `env -u CLAUDECODE sigil validate-sigil workflow.ts` before starting model work.
6. Run `env -u CLAUDECODE sigil run-sigil --repo <repo> --file workflow.ts --input input.json --out result.json --run-dir <run-dir>`. Add `--persistence ephemeral` only when loss of every input and artifact is acceptable.
7. Inspect `result.json`, artifacts, and logs. Report the answer, artifact paths, caveats, failed gates, and the next action. Do not dump raw artifacts unless the user asks.

`run-sigil` launches long runs as detached workers and writes status, events, logs, artifacts, results, and errors to the durable run directory.

## TypeScript surface

Prefer small, readable workflow bodies:

- `ctx.withAgent("role", async (agent) => ...)` for scoped agent lifecycle.
- Reuse one agent object for sequential context.
- Use `ctx.parallel([...])` for independent successful branches, or `ctx.parallelSettled([...])` when partial failure should be synthesized.
- Use structured output schemas when later steps branch on machine-readable data.
- Use `agent.prompt(..., { writes: "file.md" })` when an agent must produce an artifact.
- Use `ctx.artifacts.write/read/path` for deterministic artifact handling.
- Use `ctx.evals("build")` for configured gates and `ctx.sh(...)` for local deterministic shell/script work.
- Use `await ctx.renderContextBlock()` when a custom sigil should include configured repo context in its own prompts.
- Call shipped workflows with `ctx.run(plan, input)`, `ctx.run(implement, input)`, or other exported sigils when composition is clearer than shelling out.

Use config-backed role names such as `explorer`, `implementer`, and `reviewer` where practical. If an inline binding is necessary, set reasoning effort to `medium` unless the user explicitly requests high effort for that run.

## Temporary versus saved

Keep a sigil temporary when it serves one request. Save it in the repo when the workflow will be reused, should be reviewed, or needs tests and documentation. A saved sigil should have stable input/output types, stable prompts, and a short explanation of when to use it.

## References

- `docs/how-to/ephemeral-sigils.md`
- `docs/explanation/primitives-and-composition.md`
- `docs/explanation/prompt-patterns.md`
- `docs/explanation/workflow-patterns.md`
- `examples/08-ephemeral-sigil.ts`
