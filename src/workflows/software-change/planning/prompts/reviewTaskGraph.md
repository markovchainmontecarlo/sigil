Independently review this completed task graph against the repository, goal, brief, requirements crosswalk, and planning rubric. Write the review to {{OUT_FILE}}.

Inspect the source. Check requirement coverage, task cohesion, dependencies, produced and consumed interfaces, stable symbols and files, observable acceptance, focused verification, test coverage, scope, and stale anchors.

Report only real defects. Classify each finding using the same severity scale as code review:

- HIGH: the graph materially contradicts the accepted intent or brief, omits a required outcome, cannot execute because of a broken dependency or interface, crosses a protected boundary, would falsely claim the primary outcome, or creates a material correctness, security, or data-loss risk.
- MEDIUM: a real but bounded planning defect with a workable implementation path or narrow impact.
- LOW: optional coverage, task-shaping, documentation, style, or cleanup feedback.

Use this exact Markdown structure. Under each severity, write `None.` when there are no findings. Otherwise use one `### stable-finding-id` heading per finding, followed by `Tasks`, `Evidence`, `Defect`, and `Required change` fields.

# Planning review

## HIGH

None.

## MEDIUM

None.

## LOW

None.

Do not edit or return a replacement graph in this prompt. Do not raise the severity of optional completeness or quality improvements merely to make them actionable.

PLANNING RUBRIC:
{{RUBRIC}}

GOAL / INTENT:
{{INTENT}}

BRIEF:
{{BRIEF}}

REQUIREMENTS CROSSWALK:
{{CROSSWALK}}

TASK GRAPH:
{{TASK_GRAPH}}
