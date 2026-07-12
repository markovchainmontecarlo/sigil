# Primitives and composition

Sigil's authoring surface is intentionally small. A TypeScript Sigil is a workflow implemented as a plain async TypeScript callable over a context. YAML workflows use the same core ideas in a static, declarative shape.

The useful way to think about Sigil is not as a list of commands. It is a set of primitives for arranging tool-using agents behind deterministic workflow control.

## Readable workflow bodies

A workflow body should read top to bottom as its plain-language description. Use one statement for each conceptual step and keep those statements in execution order. Let typed return values carry state between steps.

```ts
const repository = await ctx.run(inspectRepository, input);
const options = await ctx.run(researchOptions, { input, repository });
const reviews = await ctx.parallel(options.map((option) => reviewOption(ctx, option)));
const decision = await ctx.run(selectOption, { repository, options, reviews });
const verification = await ctx.run(verifyDecision, { repository, decision });

return { decision, verification };
```

The body is dynamic because runtime results can change the options and parallel work. It remains readable because ordinary TypeScript expresses the control flow directly.

Push operation plumbing behind the operation that owns it. Prompt text and model bindings do not belong in maintained workflow bodies. Do not pass values through write-then-read artifact chains when a typed return is sufficient. Keep resource lifecycle scoped. Keep retry counters, checkpoint serialization, and issue collection in one policy-owning operation when they are not themselves consequential workflow decisions.

Do not hide meaningful behavior merely to shorten the body. Branches, bounded loop conditions, verification decisions, state transitions, and authority-bearing effects should remain visible. Readability comes from matching code statements to workflow steps, not from making TypeScript resemble YAML.

## Agent

`ctx.agent(...)` creates one tool-using agent object. The agent can be referenced by a configured name or by an inline provider/model binding. Use `ctx.withAgent(...)` when one callback should own the agent lifecycle.

Agent choice is part of workflow design. A workflow can use different model types for different jobs: a creative model for option generation, a verification-oriented model for checking claims, a smaller model for broad exploration, and a stronger model for synthesis.

```ts
const report = await ctx.withAgent("explorer", (agent) => agent.prompt("Map the repo."));

await using verifier = ctx.agent({
  provider: "codex",
  model: "<strong-codex-model>",
  effort: "medium",
});
```

## Prompt step

`agent.prompt(...)` is one prompt step. A prompt step asks one agent to do one conceptual piece of work: explore, verify, generate, critique, synthesize, repair, write an artifact, or decide a branch.

```ts
const summary = await explorer.prompt(`
Read the authentication code and summarize the current login flow.
Name the files and functions that matter.
`);
```

## Sequential context

Reuse the same agent object when later prompt steps should build on earlier context. This is useful for deep investigation: the agent can inspect the repo, form hypotheses, verify or falsify them, follow leads, and then write a comprehensive result.

```ts
await using investigator = ctx.agent("explorer");

const map = await investigator.prompt("Map the payment flow. Do not change files.");

const hypotheses = await investigator.prompt(`
Using the flow you just mapped, list the three most likely causes of duplicate charges.
For each one, name the evidence that would confirm or falsify it.
`);

const report = await investigator.prompt(`
Investigate the hypotheses you listed and write the final root-cause report.
Previous hypotheses:
${hypotheses}
`);
```

## Independent parallel analysis

`ctx.parallel([...])` runs independent jobs together. Each branch should create its own agent when the work should be isolated. Parallel analysis is useful for breadth, disagreement, and speed: several agents can inspect different surfaces, use different lenses, or try different models before a later synthesis step compares the outputs.

```ts
const [architecture, tests, risks] = await ctx.parallel([
  async () => {
    await using agent = ctx.agent("explorer");
    return agent.prompt("Analyze the architecture implications of this change.");
  },
  async () => {
    await using agent = ctx.agent("reviewer");
    return agent.prompt("Analyze the testing implications of this change.");
  },
  async () => {
    await using agent = ctx.agent("reviewer");
    return agent.prompt("Find the strongest reasons this change could fail.");
  },
]);
```

## Synthesis

A synthesis step reads several prior outputs and produces one integrated result. It should separate agreement, disagreement, evidence, uncertainty, and the final recommendation.

```ts
await using synthesizer = ctx.agent("reviewer");

const recommendation = await synthesizer.prompt(`
Synthesize these independent analyses. Preserve disagreement instead of smoothing it over.
End with one recommendation and the evidence that decides it.

ARCHITECTURE:
${architecture}

TESTS:
${tests}

RISKS:
${risks}
`);
```

## Structured output

`agent.prompt(..., Schema)` asks for machine-readable output that the workflow can branch on safely. Use structured output when a later step needs a classification, verdict, route, score, or typed object rather than prose.

```ts
import { z } from "zod";

const Classification = z.object({
  kind: z.enum(["bug", "feature", "question"]),
  reason: z.string(),
});

const classification = await explorer.prompt(
  "Classify this issue and explain the reason briefly.",
  Classification,
);

if (classification.kind === "bug") {
  // Run the bug path.
}
```

## Artifact write

`agent.prompt(..., { writes: "file.md" })` requires the agent to produce a named artifact file instead of only returning text. `ctx.artifacts.write/read/path` handles deterministic artifact writes, reads, and path resolution through the same artifact root. Artifacts are useful for reports, plans, requirements bundles, decision records, reproduction scripts, and other outputs that should outlive one prompt turn.

```ts
const requirements = await explorer.prompt("Write the requirements bundle.", {
  writes: "requirements.md",
  minBytes: 500,
});

return {
  requirements,
  requirementsPath: ctx.artifacts.path("requirements.md"),
};
```

## Artifact handoff

An artifact written by one step can become input to a later step. Use artifacts for long outputs, independent review, durable evidence, or handoffs between agents.

```ts
await explorer.prompt("Write a migration plan.", {
  writes: "migration-plan.md",
  minBytes: 1000,
});

await using critic = ctx.agent("reviewer");
const critique = await critic.prompt(`
Review the migration plan at ${ctx.artifacts.path("migration-plan.md")}.
Find unsupported claims, missing rollback steps, and sequencing risks.
`);
```

## Eval gate

`ctx.evals("build")` runs a named deterministic check from config. Gates are what make workflow output trustworthy: the model can propose or repair, but a command such as build, test, typecheck, lint, e2e, or verify decides whether the check passed.

```ts
const gate = await ctx.evals("test");

if (!gate.ok && !gate.skipped) {
  ctx.issue(`test failed: ${gate.log}`);
}
```

## Shell or script step

Some workflow work is deterministic and should not be done by a model. Use shell or script steps for parsing, validation, file checks, data shaping, repository probes, and command execution.

```ts
const diff = await ctx.sh(["git", "diff", "--", "src"]);

if (!diff.ok) {
  ctx.issue(diff.message);
}

const packageFile = await ctx.sh("cat package.json");
```

## Conditional branch

A workflow can branch on structured model output or deterministic state. Common branches are classify and route, continue or stop, repair or publish, research further or synthesize, and plan or decompose.

```ts
if (classification.kind === "question") {
  await explorer.prompt("Write a short answer and list the missing information.", {
    writes: "answer.md",
  });
  return { routedTo: "answer", issues: ctx.issues };
}

if (classification.kind === "bug") {
  return ctx.run(plan, {
    repo: input.repo,
    intent: input.issue,
  });
}
```

## Nested workflow

`ctx.run(child, input)` calls another workflow through the same `SigilContext` and artifact root. This is how larger workflows compose smaller ones without inventing a second orchestration layer. Use `ctx.fork(...)` explicitly when a child operation needs its own artifact namespace.

```ts
import { sigil, softwareChange } from "sigil";

export const buildChange = sigil(
  "build-change",
  async (ctx, input: { repo: string; intent: string }) => {
    return ctx.run(softwareChange, {
      repo: input.repo,
      intent: input.intent,
    });
  },
);
```

## Issue accumulation

`ctx.issue(...)` records non-fatal problems while allowing the workflow to continue. Use issues when a run should finish with caveats rather than fail at the first concern.

```ts
if (critique.includes("unsupported")) {
  ctx.issue("review found unsupported claims in the migration plan");
}

return {
  recommendation,
  issues: ctx.issues,
};
```

## Configured context

`sigil.config.json` can list repo-specific context files. Sigil loads them at run start as orientation. Agents must still verify important claims against source files or runtime behavior.

```json
{
  "context": [
    { "path": "docs/architecture.md", "update": false },
    { "path": "docs/status.md", "update": true }
  ]
}
```

Inside a TypeScript Sigil, built-in workflows such as `plan` and `implement` load configured context for you. A custom workflow can call `await ctx.renderContextBlock()` and include the rendered context in its own prompts when it needs the same orientation behavior.

## Agent bindings

Agent bindings connect a workflow role to an agent-runtime integration, model, and reasoning effort. This lets a workflow arrange models strategically instead of treating every agent session as interchangeable.

```json
{
  "agents": {
    "explorer": { "provider": "codex", "model": "<fast-codex-model>", "effort": "medium" },
    "designer": { "provider": "claude", "model": "<creative-claude-model>", "effort": "medium" },
    "advisor": { "provider": "copilot", "model": "<copilot-model>", "effort": "medium" },
    "reviewer": { "provider": "codex", "model": "<strong-codex-model>", "effort": "medium" }
  }
}
```

## Tool use through agents

Agents can use the tools exposed by their runtime: read files, search the repo, edit files, run commands, search the web when available, inspect docs, or create artifacts. Sigil does not need to own every tool. Its job is to arrange tool-using agents inside deterministic workflow structure.

```ts
const report = await explorer.prompt(`
Research the current recommended migration path for this library.
Use web search if your tool environment supports it.
Then compare the current docs with this repository's usage and write a recommendation.
`);
```

## Delivery policy

A delivery policy is the caller's rule for what to do with completed work. Workflows can produce work, verify it, review it, and prepare delivery artifacts, but the caller decides whether to publish, merge, queue, stop, or run more checks.

This keeps production and delivery separate. For example, `implement` returns a branch and PR body, while a caller can decide to open a PR, stop on review findings, merge only after green gates, or hand the result to another workflow.

```ts
const implemented = await ctx.run(implement, {
  repo: input.repo,
  taskFile: planned.taskFile,
});

if (implemented.reviewBlocking || implemented.failedTasks.length > 0) {
  return { shipped: false, reason: "review-blocking", implemented };
}

const published = await publish(input.repo, {
  branch: implemented.branch,
  title: implemented.branch,
  body: implemented.prBody,
  base: "main",
});

return { shipped: published.pr?.ok === true, implemented, published };
```

## Composition

Sigil workflows compose in ordinary TypeScript. You can call built-in workflows or custom TypeScript Sigils directly. The workflow model is not a separate orchestration DSL.

```ts
export const investigateThenDecide = sigil(
  "investigate-then-decide",
  async (ctx, input: { repo: string; question: string }) => {
    const [repoReport, externalReport] = await ctx.parallel([
      async () => ctx.agent("explorer").prompt(`Investigate the repo for: ${input.question}`),
      async () => ctx.agent("explorer").prompt(`Research external context for: ${input.question}`),
    ]);

    await using synthesizer = ctx.agent("reviewer");
    const decision = await synthesizer.prompt(`
Compare the repo report and external report. Decide what to do next.

REPO:
${repoReport}

EXTERNAL:
${externalReport}
`);

    return { decision, issues: ctx.issues };
  },
);
```
