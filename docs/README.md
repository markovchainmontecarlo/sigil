# Developer documentation

Sigil supports two main development modes. In AI-assisted development, your current code assistant creates the task graph from the agreed requirements. Choose agentic development when you want Sigil to investigate, plan, or deliver work with less direct supervision.

Both modes converge on the same validated task graph and implementation workflow.

## Repository developers

Learn the main workflows in this order:

1. [Make your first change with an AI assistant](./tutorials/first-change-with-ai-assistant.md)
2. [Run an agentic single change](./tutorials/agentic-single-change.md)
3. [Deliver a multi-change program](./tutorials/agentic-program-delivery.md)

When you already know the operation you need:

- [Author a task graph with an AI assistant](./how-to/author-task-graph-with-ai-assistant.md)
- [Implement an accepted task graph](./how-to/implement-accepted-task-graph.md)
- [Configure provider profiles](./how-to/configure-provider-profiles.md)

The [task-graph reference](./reference/task-graph.md) defines the contract and validation rules. [SIGIL_USAGE.md](../SIGIL_USAGE.md) lists commands, behavior, and operational boundaries.

## Workflow authors

Custom orchestration can use the following workflow concepts and authoring surfaces:

- [Workflow shapes](./explanation/workflow-shapes.md)
- [Primitives and composition](./explanation/primitives-and-composition.md)
- [Prompt patterns](./explanation/prompt-patterns.md)
- [Workflow pattern catalog](./explanation/workflow-patterns.md)
- [Create and run a temporary TypeScript Sigil](./how-to/temporary-typescript-sigil.md)

Use YAML when every stage, job, and step is known before execution. Use a TypeScript Sigil when runtime evidence changes the workflow shape.

## Application developers

Production applications should acquire jobs through application-owned infrastructure and execute them in Node-compatible workers. [Run Sigil from a server application](./how-to/server-application.md) covers the worker boundary, external artifacts, cancellation, and result handling.

Use `sigil/contracts` for task-graph, backlog, and YAML contracts. Use `sigil/server` to execute one already-acquired job. Do not run long workflows inside an HTTP request or restricted Edge runtime.

## Concepts and reference

- [LLMs, agent runtimes, agents, and workflows](./explanation/llms-agents-and-workflows.md)
- [Provider routing](./explanation/provider-routing.md)
- [Configuration reference](./reference/configuration.md)
- [Provider profile reference](./reference/provider-profiles.md)
