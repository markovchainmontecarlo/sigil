Rewrite the backlog in place at {{OUT_FILE}}, enriching every item's brief field. Work in this order:

1. Read {{OUT_FILE}} and the backlog below in full.

2. For every item, replace brief with one self-contained intent paragraph that an independent plan run can execute against a future HEAD. Include the item's goal, constraints, and an acceptance sketch. Do not include file paths, line numbers, or stale anchors.

3. Preserve the JSON contract shape, item ids, dependency ids, dependency order, and mission. Do not add scope.

MISSION:
{{MISSION}}

BACKLOG:
{{BACKLOG}}
