# LLMs, agent runtimes, agents, and workflows

Sigil is a workflow runtime over tool-using agent runtimes. This glossary names each layer so models, live sessions, workflow code, CLI commands, and assistant skills are not treated as the same object.

## The stack

```text
Sigil workflow
  owns control flow, state transitions, artifacts, gates, and composition

Agent session
  supplies bounded judgment through a continuing tool-using context

Agent runtime
  supplies tools, session continuity, permissions, and model access

LLM
  supplies reasoning, language generation, and structured output
```

The supporting surfaces sit beside that execution stack:

```text
Agent binding  selects a runtime integration, model, and reasoning effort
Sigil CLI      adapts user commands to workflows and runtime services
Skill          tells an assistant how to select or operate Sigil
```

## LLM

A large language model supplies reasoning, language generation, and structured output. A raw model call does not by itself provide repository tools, file edits, shell commands, durable artifacts, gates, or workflow control flow.

## Model provider

A model provider is the service or product family that supplies model access. Provider identity and model identity are configuration choices, not live agent sessions.

## Agent runtime

An agent runtime places a model inside a tool-using environment. It owns session continuity, tool availability, permission handling, and communication with the model provider.

Sigil integrates several agent runtimes behind the common `SigilAgent` interface in `src/agents.ts`. The integrations do not all use the same transport:

- Claude uses a Mastra adapter over the Claude Agent SDK.
- Codex uses Mastra ACP with a Codex ACP process.
- GitHub Copilot uses the Copilot SDK.

Call these agent-runtime integrations or provider adapters when the transport does not matter. Use the precise term, such as SDK, CLI, or protocol adapter, only when that implementation boundary matters.

## Agent SDK, provider CLI, and protocol adapter

An **agent SDK** is a library interface used to launch or communicate with an agent runtime.

A **provider CLI** is an executable interface used to host or communicate with an agent runtime. Qualify it as a provider CLI so it is not confused with the Sigil CLI.

A **protocol adapter** bridges Sigil to an agent runtime through a protocol such as ACP.

These are integration mechanisms. They are not different kinds of workflow.

## Agent role, binding, and session

An **agent role** is a repository-configured name such as `explorer`, `implementer`, or `reviewer`.

An **agent binding** maps that role to an agent-runtime integration, model, and reasoning effort:

```json
{
  "reviewer": {
    "provider": "codex",
    "model": "<model-name>",
    "effort": "medium"
  }
}
```

An **agent session** is the live tool-using model context created when a workflow resolves a binding through `ctx.agent(...)`. Reuse the same agent object when later prompts should share context. Create separate agent objects when work should remain independent.

The agent session supplies judgment inside a bounded operation. It may read files, search, edit, run tools, and return prose or structured output. It does not own deterministic gate outcomes or the parent workflow's state transition.

## Operation

An operation is one conceptual bounded action inside a workflow, such as a prompt, gate, script, artifact write, nested workflow call, or external effect. It is useful architectural vocabulary, but it is not necessarily a first-class runtime type.

## Workflow

A workflow coordinates operations and owns a state transition. It decides which agent runs, which operations run sequentially or in parallel, what artifacts are written, what gates must pass, and when to stop, repair, continue, or invoke another workflow.

Agents supply judgment. Users, callers, or configured policy grant authority. Deterministic code enforces authority boundaries and owns persistence, gates, checkpoints, and effect execution.

## TypeScript Sigil and YAML workflow

A **TypeScript Sigil** is a workflow implemented with the `sigil()` TypeScript API. TypeScript supplies ordinary control flow; Sigil supplies agents, artifacts, gates, parallel execution, issues, configured context, and nested workflow calls.

A **YAML workflow** is the declarative surface for a fixed stage, job, and step topology.

Use **workflow** as the general term. Use **TypeScript Sigil** when the `sigil()` implementation surface matters. A TypeScript Sigil is one way to implement a workflow, not a separate layer above or below workflows.

## Built-in and custom workflows

A **built-in workflow** is a callable workflow shipped by Sigil, such as `plan`, `softwareChange`, or `dispatch`.

A **custom workflow** is a temporary or maintained TypeScript Sigil or YAML workflow created for a repository or use case.

Workflows compose from operations and nested workflows. Avoid describing this as sigils being stitched into a different workflow layer.

## Sigil CLI

The Sigil CLI is the user-facing command surface. A command parses input, invokes a workflow or runtime service, formats output, and maps the outcome to an exit code. Workflow commands are thin adapters and do not own workflow state transitions.

Some CLI adapters add an external effect after a workflow returns. For example, the `implement` workflow returns branch state and a pull-request body, while the `sigil implement` command may publish that branch. Documentation must name the workflow boundary and CLI effect separately.

## Skill

A skill is assistant-facing operating guidance. It helps an assistant decide whether Sigil adds value, choose a built-in or custom workflow, and operate specialized workflows safely. A skill is not a runtime workflow, agent, prompt, or CLI command.

## Run data

- A **workflow run** is one workflow invocation under a `SigilContext`.
- A **detached run** is a worker-managed TypeScript workflow run with launcher status, events, logs, result, and error files.
- A **result** is the typed value returned by a workflow.
- An **artifact** is a named file output or piece of evidence owned by a workflow context. Its durability follows the run persistence policy.
- **Checkpoint state** is resumable progress owned by a stateful workflow. It is not an ordinary output artifact.
- A **contract** is a typed handoff across workflow or stage boundaries.
- A **gate** is a deterministic evaluation that owns pass or fail.

## Why the distinctions matter

The model reasons. The agent runtime provides tools and context. The agent session performs bounded judgment. The workflow owns control flow and state transitions. The caller grants authority. Deterministic code enforces boundaries and verifies effects. The CLI exposes those capabilities, and skills help assistants choose them.

Keeping those responsibilities separate is what makes workflows independently callable, safely composable, and able to reuse accepted artifacts without repeating finished work.
