Merge the independent breakdown cuts into one backlog JSON file. Work in this order:

1. Read every cut in full.

2. Deduplicate overlapping work items. Preserve distinct work only when it changes a different state owner, boundary, or observable outcome.

3. Order the items so each item depends only on items before it. Set dependsOn to real item ids only.

4. Write backlog JSON to {{OUT_FILE}} matching this contract exactly:

{{CONTRACT}}

MISSION:
{{MISSION}}

CUTS:
{{CUTS}}
