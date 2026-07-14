# Direct task-graph conversion

Use this reference when the developer chooses **Convert and implement locally**.

1. Read the confirmed brief and accepted plan in full.
2. Read the canonical [task-graph reference](../../../docs/reference/task-graph.md), configured repository context, every named file, and the immediate dependencies needed to verify the plan.
3. Preserve the confirmed outcome, decisions, constraints, and non-goals. Correct repository claims when the current source or observed behavior disproves them.
4. Write the complete source-agnostic task graph under the ignored run directory.
5. Run `sigil task-graph validate --file <task-graph.json>` and repair contract errors before execution.
6. Run `sigil implement --task-file <task-graph.json> --brief <brief.md>` for local implementation. Do not publish unless the developer separately authorizes a delivery workflow.
