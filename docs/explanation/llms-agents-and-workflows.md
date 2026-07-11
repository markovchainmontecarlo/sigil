# LLMs, agents, agent SDKs, and workflows

Sigil sits above agent runtimes. It uses agents for tool-using work and TypeScript workflows for deterministic orchestration.

## The stack

```text
Sigil workflow
  owns: control flow, branching, parallel work, artifacts, gates, composition

Agent SDK / agent runtime
  owns: tool use, session context, source reads, file edits, shell/browser/search tools

LLM
  owns: language, reasoning, generation, structured output
```

The boundary matters. The model can reason and generate. The agent runtime gives the model tools and a continuing session. The workflow decides what runs next, what must be checked, and how each result becomes input to the next step.

## LLM

A large language model is the raw model capability. You send input, and it returns text or structured output. By itself, an LLM does not define tool use, file edits, shell commands, retries, artifacts, gates, or workflow control flow.

Raw LLM calls are useful for small structured tasks: classify this input, rewrite this paragraph, extract these fields, summarize this text. Once the task needs repository tools, web or docs search, multi-turn investigation, durable files, or repair loops, a raw model call is only one part of the system.

## Agent

An agent is an LLM operating inside a bounded runtime that can carry context across turns and use tools. Those tools might include repository search, file reads and writes, shell commands, browser or web search tools, and provider-specific capabilities.

In Sigil terms, one `ctx.agent(...)` call creates one agent object. Reusing that object keeps one shared conversation. Creating a new agent object gives the workflow an independent context.

## Agent SDK

An agent SDK is the programmatic interface for launching and talking to an agent runtime. Sigil builds on agent SDKs instead of raw LLM endpoints because the useful work often happens through tool-using agents, not isolated completions.

In this repo, `src/agents.ts` is the seam that wraps Claude, Codex, and GitHub Copilot behind one `SigilAgent` interface. Sigil does not need every provider to expose identical internals. It needs a common way to prompt an agent, ask for structured output when supported, and close the agent when the workflow is done.

## Workflow

A workflow is the deterministic structure around one or more agents. It owns the shape of the work: which agent runs, which prompt runs next, which steps run in parallel, what artifacts must be written, what gates must pass, and when to stop, repair, continue, or publish.

The agent owns the tool-using work inside a step. The workflow does not micromanage every search query, and the agent does not decide whether a deterministic gate passed.

## What a sigil is in this stack

A sigil is the workflow layer written as TypeScript. It arranges agents, prompt steps, artifacts, deterministic checks, and nested sigils. The agent does the tool-using work; the sigil decides the shape of the work.

A research sigil might create several agents with separate contexts, ask each to investigate a different angle, synthesize their findings with a fresh agent, and write a report artifact. A software engineering sigil might plan a change, implement each task, run build and test gates, review the diff with a fresh agent, and return a PR body for the caller's delivery policy.

## Raw LLM workflow versus agent SDK workflow

A workflow that calls raw LLM endpoints usually owns prompt construction, validation, tool wiring, context movement, and any file edits itself. That can work well for simple prompt chains and small structured outputs.

A workflow that calls agent SDKs delegates bounded cognitive work to stronger tool-using agents, while deterministic code still owns orchestration. That is the category Sigil fits. Sigil lets agents search, read, write, investigate, and reason inside steps, while the TypeScript workflow owns branching, parallelism, artifacts, gates, and composition.

## What Sigil owns

Sigil owns the deterministic workflow layer:

- control flow
- agent selection
- sequential or independent contexts
- parallel analysis
- synthesis steps
- artifact paths and handoffs
- structured-output boundaries
- eval gates
- shell or script checks
- nested sigils
- issue accumulation
- delivery-policy boundaries

## What the agent owns

The agent owns the tool-using work inside a prompt step:

- reading files
- searching the repository
- editing files when asked
- running tools exposed by its runtime
- using web search when the runtime supports it
- reasoning over the context it has gathered
- producing prose, structured output, or artifact files

## Workflow surfaces

Sigil exposes TypeScript sigils for dynamic workflows, saved workflows, and temporary one-off workflows. It also exposes YAML workflows for static stage/job/step structures. See [Workflow shapes: static and dynamic](./workflow-shapes.md) for the difference.

## Why this distinction matters

Sigil is not only a prompt helper and not only an agent wrapper. The value is the workflow layer around agents: composition, deterministic checks, artifact flow, model specialization, and reusable structure.

That is what lets a user ask for a larger outcome in ordinary language while Sigil arranges multiple agents, custom prompts, intermediate artifacts, and verification steps behind the scenes.
