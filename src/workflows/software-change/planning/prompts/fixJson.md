The task graph JSON file at {{FILE}} failed deterministic contract validation. Fix it. Work in this order:

1. Read {{FILE}} in full.

2. Resolve each of these validation errors:
{{ERRORS}}

3. Read whatever repo files you need to resolve each error correctly. Do not invent a value to silence a check. Match this contract:

{{CONTRACT}}

4. Write valid, parseable JSON back to {{FILE}}, preserving every task's intent and scope.
