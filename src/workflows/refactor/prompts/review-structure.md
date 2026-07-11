Review the refactor diff against the requested ownership and dependency direction.

Look for misplaced responsibilities, reversed dependencies, duplicated mechanisms, compatibility residue, incomplete moves, stale paths, and unnecessary abstraction. Do not request preservation of internal file locations unless the intent explicitly requires compatibility. Do not request unrelated improvements. Return a structured verdict. Give every finding a stable short id based on the affected boundary and defect. Reuse an existing id when reporting the same defect again.

KNOWN FINDING IDS AND ATTEMPTS:
{{KNOWN_FINDINGS}}

INTENT:
{{INTENT}}

PLAN:
{{PLAN}}

DISCOVERED PATHS AND JUSTIFICATIONS:
{{DISCOVERIES}}

DIFF:
{{DIFF}}
