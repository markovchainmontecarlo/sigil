{{PREAMBLE}}

## Your task: {{TASK_ID}} — {{TASK_TITLE}}

{{TASK_SUMMARY}}

{{DIAGRAMS}}

{{CONTEXT}}

{{HANDOFF}}

### First: verify and falsify the claims in this task
Read the actual code for every file this task touches before you change anything. Verify and falsify the task's claims against what you find at HEAD. This is not ceremony and it is not a gate. The point is to force you to read the code and form your own opinion before acting, instead of executing the plan blind. That includes the task's design decisions, not just its facts: if the prescribed approach is wrong or inferior for this task's goal given what you read, say so and carry the better approach into your implementation. In one or two lines, state what you confirmed and what, if anything, the task got wrong about the current code.

### Then: implement toward the goal
The acceptance criteria are the contract of OUTCOME — the observable behavior this task exists to produce. Satisfy what they prove:
{{ACCEPTANCE}}

Your box is this task's goal, its declared files, and those outcomes. Inside the box, mechanism is yours. When a criterion or detail prescribes HOW and your read of the code shows a better mechanism for the same outcome, implement the better mechanism — a spec can be wrong, and faithfully implementing a wrong spec is a failure, not compliance. Every such deviation must be declared: name the prescription you overrode, what you did instead, and the evidence that yours serves the goal better. Never use deviation to expand scope, skip an outcome, or weaken a check.

The files and details below are the plan's best guess at how, not scripture. Changes should stay within the task's declared files. When correctness genuinely requires touching another file, name each such file in the final reply and give the reason in one line. If your read of the code shows a detail is stale, a path moved, or a minor change is needed to actually satisfy the acceptance criteria, adapt and do the right thing. Note any deviation and why. Do not follow a stale detail off a cliff; do not expand scope beyond this task's goal.
{{FILES}}

### Keep configured write-back context true
If a configured context file is marked `update: true` and this task makes one of its statements false, update that file in this same change so the context merges with the code or status it describes. Keep it tight; make the smallest in-place edit, do not append a changelog entry, do not restate the diff, and do not touch it when nothing it says has changed. Anchor claims on file and symbol names, not line numbers or other volatile numbers (line ranges, counts, sizes); never add or adjust such numbers, which churn on every edit without adding value. For work or status registers, remove completed items or update their status instead of appending a done note; the commit or PR is the record of completion. Files marked `update: false` are read-only context unless this task explicitly declares them as output files.

Make the edits now. When done, state what you changed and any deviation from the plan and why.
