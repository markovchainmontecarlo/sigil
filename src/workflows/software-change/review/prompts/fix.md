Fix the findings you just wrote, in this checkout. Fix EVERY HIGH. Fix a MEDIUM only when the correction is small, low-risk, and inside this change's scope; otherwise leave it and say why. Do not fix LOWs. Beyond the findings your default is ZERO changes: do not refactor, restyle, rename, or improve anything not named in a finding. Each edit must trace to a specific finding. Re-verify each defect against the source before changing it. If a finding is actually wrong, skip it and say why; a justified skip counts as resolved.

Your fixes are code changes like any other: after applying them, run this repository's build and test commands yourself and read the output. If a fix changes behavior that existing tests or fixtures encode, updating those tests within the finding's scope is part of the fix — do it and say so. Work until you have OBSERVED the commands pass; do not end your turn on a fix you have not seen build and pass. The harness re-runs the same gates after your turn.

After fixing, state per finding what you changed, why no change was needed, or why you left it.

CONFIRMED FINDINGS:
{{FINDINGS}}

End your reply with exactly one line, nothing after it:
UNRESOLVED-HIGH: <count>
