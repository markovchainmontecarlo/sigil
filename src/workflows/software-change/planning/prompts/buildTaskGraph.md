Build the task graph from the verified convergence and the resolved divergences. Work in this order:

1. Assemble the tasks: one coherent, independently verifiable task per unit of work. Take each point of agreement as verified, applying the correction where the convergence verification marked it FALSIFIED. Take each divergence as the recommended solution from the resolution report.

2. Order the tasks so each depends only on tasks before it, and set each task's dependencies to the task ids it needs.

3. Write the task graph as JSON to {{OUT_FILE}}, with every files[].path repo-relative, every dependency a real task id, and each task's summary carrying the decision behind it. For a resolved divergence, include the recommendation and what it beat. Project must be a short kebab-case project name: lowercase letters, digits, and hyphens, at most 40 characters, never a filesystem path. Match this contract:

{{CONTRACT}}

GOAL / INTENT:
{{INTENT}}

VERIFIED CONVERGENCE:
{{CONVERGENCE_VERIFIED}}

RESOLVED DIVERGENCES:
{{DIVERGENCE_RESOLVED}}
