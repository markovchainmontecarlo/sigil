# Ephemeral sigils

This page is for an assistant creating a one-off TypeScript sigil on behalf of a user. The user should not have to know the Sigil API. The assistant designs the workflow, writes the temporary TypeScript file, runs it, inspects the artifacts, and returns the useful result.

An ephemeral sigil is a TypeScript sigil written for one substantial request. It uses the same mechanism as any other sigil. Save it as a maintained workflow when it will be reused. Keep a one-off workflow in the repository's ignored `.sigil/runs/` directory when its evidence or logs may be inspected later.

Use an ephemeral sigil when the task will take minutes rather than seconds and benefits from multiple agents, multiple prompt steps, artifacts, gates, or model specialization. Do not use one when a normal assistant answer is enough, one model turn can answer reliably, a built-in sigil already fits, or the workflow should clearly be saved for reuse.

Good examples are multi-agent research, repo exploration followed by deep analysis, creative options checked by verification-oriented agents, or an artifact that should be drafted, critiqued, repaired, and validated.

## Design the run

Before writing the file, decide the user's concrete goal, what should run in parallel, what should build sequential context, which agent roles fit each step, what artifacts should exist, what can be checked deterministically, and what the final result should contain. Use the smallest workflow that earns the orchestration cost. A custom prompt chain is good. Unnecessary machinery is not.

## Use a run directory

Create a durable ignored run directory so the work remains inspectable:

```text
<repo>/.sigil/runs/<topic>/
  workflow.ts
  input.json
  artifacts/
  result.json
  run.log
```

Use a stable topic name when the user may ask about the run later. Sigil records detached-run state, events, logs, artifacts, results, and errors in this directory. Use operating-system temporary storage only when the entire run is disposable, and select `--persistence ephemeral` explicitly.

## Minimal template

A temporary sigil file only needs to export a callable workflow. The CLI runner supplies the context, keeps artifacts under the run directory when one is provided, and writes the formatted JSON result.

```ts
import { sigil } from "sigil";

export default sigil(
  "custom-investigation",
  async (ctx, input: { repo: string; question: string }) => {
    await using investigator = ctx.agent("explorer");

    const report = await investigator.prompt(`
Investigate this question. Read the relevant repo files or sources before deciding.

Question:
${input.question}
`);

    await investigator.prompt("Write the final report as markdown.", {
      writes: "report.md",
      minBytes: 200,
    });

    return {
      report,
      reportPath: ctx.artifacts.path("report.md"),
      issues: ctx.issues,
    };
  },
);
```

Write input as JSON:

```json
{
  "question": "question or task"
}
```

Validate the export before starting a long run, then run it with `run-sigil`:

```sh
env -u CLAUDECODE sigil validate-sigil workflow.ts
env -u CLAUDECODE sigil run-sigil --repo /path/to/repo --file workflow.ts --input input.json --out result.json --run-dir .
```

`run-sigil` launches a detached worker. Inspect its status and follow its log from the durable run directory:

```sh
cat status.json
tail -f run.log
```

For a deliberately disposable run, use a temporary directory and make the persistence choice explicit:

```sh
run_dir="$(mktemp -d)"
env -u CLAUDECODE sigil run-sigil \
  --repo /path/to/disposable-worktree \
  --file "$run_dir/workflow.ts" \
  --input "$run_dir/input.json" \
  --run-dir "$run_dir" \
  --persistence ephemeral
```

Direct `bun workflow.ts` execution is a lower-level development option for scripts that create their own context. Prefer `run-sigil` for assistant-authored runs because it supplies the context, merges input with the resolved repo path, writes the result JSON, and places artifacts under the run directory. See [SIGIL_USAGE.md](../../SIGIL_USAGE.md) for the broader CLI reference.

## Example: parallel analysis and synthesis

This shape is useful when the user asks for advice, research, design review, or a substantial comparison.

```ts
import { sigil } from "sigil";

export default sigil(
  "parallel-analysis-and-synthesis",
  async (ctx, input: { repo: string; question: string }) => {
    const [architecture, risks, evidence] = await ctx.parallel([
      async () => {
        await using agent = ctx.agent("explorer");
        return agent.prompt(`Analyze the architecture angle for this question:\n${input.question}`);
      },
      async () => {
        await using agent = ctx.agent("reviewer");
        return agent.prompt(`Find risks, weak claims, and missing constraints for this question:\n${input.question}`);
      },
      async () => {
        await using agent = ctx.agent("explorer");
        return agent.prompt(`Verify or falsify the key claims implied by this question:\n${input.question}`);
      },
    ]);

    const architecturePath = await ctx.artifacts.write("architecture.md", architecture);
    const risksPath = await ctx.artifacts.write("risks.md", risks);
    const evidencePath = await ctx.artifacts.write("evidence.md", evidence);

    await using synthesizer = ctx.agent("reviewer");
    const synthesis = await synthesizer.prompt(`
Synthesize these independent reports. Preserve disagreement, cite evidence, and end with a recommendation.

ARCHITECTURE:
${architecture}

RISKS:
${risks}

EVIDENCE:
${evidence}
`);

    const synthesisPath = await ctx.artifacts.write("synthesis.md", synthesis);

    return {
      synthesis,
      artifacts: {
        architecture: architecturePath,
        risks: risksPath,
        evidence: evidencePath,
        synthesis: synthesisPath,
      },
      issues: ctx.issues,
    };
  },
);
```

The real workflow should be custom to the request. Change the agents, prompts, branches, artifacts, and gates to match the user's goal.

## Report the result

After the run, inspect `result.json`, artifacts, and `run.log`. Return the main answer or synthesis, what workflow ran, artifact paths, caveats, failed gates, and the next action if one is obvious. Do not dump every raw artifact into chat. Summarize the result and point to files when details matter.

## When to save it

Promote an ephemeral sigil to a saved sigil when the same workflow is run more than once, prompts are becoming stable, other users or agents should reuse it, or it needs tests and documentation. A saved sigil should have a clear input type, output type, stable prompts, and documentation for when to use it.
