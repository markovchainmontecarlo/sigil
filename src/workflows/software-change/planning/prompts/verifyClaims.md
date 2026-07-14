Verify the reports and requirements crosswalk against the repository. Read complete affected files and trace stable symbols, callers, dependency direction, configuration ownership, tests, and proposed commands.

Write convergence verification to {{CONVERGE_VERIFY_FILE}}. For every claim, provide repository evidence and a VERIFIED or FALSIFIED verdict with the correction when falsified.

Write divergence verification to {{DIVERGE_VERIFY_FILE}}. Verify every position, task boundary, produced and consumed interface, dependency claim, and verification strategy.

Write crosswalk verification to {{CROSSWALK_VERIFY_FILE}}. Verify every requirement, constraint, and non-goal against the intent and brief, and confirm that the mapped tasks actually cover it.

GOAL / INTENT:
{{INTENT}}

CONVERGENCE REPORT:
{{CONVERGENCE}}

DIVERGENCE REPORT:
{{DIVERGENCE}}

REQUIREMENTS CROSSWALK:
{{CROSSWALK}}
