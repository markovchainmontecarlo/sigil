# Create and run a temporary TypeScript Sigil

Use a temporary TypeScript Sigil for one substantial request when dynamic orchestration adds value and no built-in workflow already owns the required transition. A user should be able to describe the outcome and boundaries without learning the TypeScript API.

Use a direct answer or edit for simple work. Use YAML when every stage, job, and step is known before the run. Save the workflow as maintained project code when it will be reused, reviewed, tested, or documented as a stable capability.

## 1. Choose the workflow shape

Read the [workflow pattern catalog](../explanation/workflow-patterns.md). Select the smallest pattern that fits the outcome, then establish:

- input and final result;
- sequential context and independent parallel work;
- agent roles;
- artifacts that carry evidence or outputs;
- deterministic gates;
- repository and external effects;
- protected resources;
- partial-failure and stopping behavior.

## 2. Write the workflow

Create `workflow.ts` in the target repository or another durable location. The runner creates an ignored durable run directory under `<repo>/.sigil/runs/` when `--run-dir` is omitted.

```ts
import { sigil } from "sigil";

export default sigil(
  "custom-investigation",
  async (ctx, input: { repo: string; question: string }) => {
    const context = await ctx.renderContextBlock();

    const report = await ctx.withAgent("explorer", (agent) =>
      agent.prompt(
        [
          "Investigate the question using repository evidence.",
          context,
          `Question: ${input.question}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
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

Use an input file only when structured input is useful:

```json
{
  "question": "question or task"
}
```

## 3. Validate and launch

Validate the export before starting model work:

```sh
env -u CLAUDECODE sigil validate-sigil workflow.ts
```

Launch the workflow. Input, output, and run-directory flags are optional controls:

```sh
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/repo \
  --file workflow.ts \
  --input input.json
```

`run-sigil` launches a detached worker and prints its run handle. Follow the returned status and log paths. Supply `--run-dir` only when a stable explicit location materially helps the user or another system.

Use `--persistence ephemeral` only when the workflow, inputs, evidence, logs, and result are deliberately disposable. See [SIGIL_USAGE.md](../../SIGIL_USAGE.md) for exact persistence and runner behavior.

## 4. Inspect and report

Wait for terminal worker status, then inspect:

- the typed result;
- material artifacts;
- recorded issues;
- failed gates;
- the error file when the worker failed.

Return the useful answer or completed action. Include artifact paths when they help the user inspect evidence. Do not dump raw logs or every intermediate artifact by default.

## 5. Promote when appropriate

Move the TypeScript Sigil into maintained project code when the shape will be reused or should become a reviewed repository capability. Add stable input and result types, stable prompt bindings, tests, and a concise explanation of when to use it.
