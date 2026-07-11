Repair the existing implementation branch for backlog item {{ITEM_ID}} without resetting it or repeating completed tasks.

Item goal and constraints:
{{BRIEF}}

Validated task graph:
{{TASK_FILE}}

Blocking evidence:
{{EVIDENCE}}

Read the task graph, current branch commits, review artifacts, and current code. Preserve completed task commits. Repair every unmet acceptance criterion, gate failure, review finding, or weakened-test finding named by the evidence. Follow relevant dependencies beyond planned file lists when necessary. Do not weaken verification or change protected authority boundaries.
