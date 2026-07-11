Verify these claims against the actual repository at the cwd. Base every verdict on the code you read. Work in this order:

1. Read the full files named anywhere in the convergence report and the divergence report.

2. Write the convergence verification as markdown to {{CONVERGE_VERIFY_FILE}}. For each point of agreement, write: the claim; the evidence in the code at file:line; a verdict of VERIFIED or FALSIFIED; and if FALSIFIED, what the code actually shows and the correction the claim needs.

3. Write the divergence verification as markdown to {{DIVERGE_VERIFY_FILE}}. For each point of disagreement, and for each position within it, write: the position and which planner holds it; the evidence in the code at file:line; a verdict of VERIFIED or FALSIFIED for that position; and if FALSIFIED, what the code actually shows.

GOAL / INTENT:
{{INTENT}}

CONVERGENCE REPORT:
{{CONVERGENCE}}

DIVERGENCE REPORT:
{{DIVERGENCE}}
