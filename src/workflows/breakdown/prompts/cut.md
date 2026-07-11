Break this mission into an independent implementation cut. Work in this order:

1. Investigate the repository read-only. Read the code paths that would change and the tests or commands that prove the behavior.

2. Propose ordered work items sized so each item can ship as one pull request. Each item must have a stable kebab-case id, a one-sentence goal, dependency ids that point only to earlier items, and one line explaining why that boundary is the right PR boundary.

3. Write the cut as markdown to {{OUT_FILE}}. Do not write JSON. Do not edit the repository.

MISSION:
{{MISSION}}
