Repair only the supported semantic review findings in the task graph at {{TASK_FILE}}.

Read the repository evidence for every finding. Preserve verified requirements, accepted architecture, constraints, non-goals, and unrelated graph content. Do not broaden scope or delete detail merely to make a finding disappear. Write the complete repaired graph back to {{TASK_FILE}} using this contract:

{{CONTRACT}}

FINDINGS:
{{FINDINGS}}
