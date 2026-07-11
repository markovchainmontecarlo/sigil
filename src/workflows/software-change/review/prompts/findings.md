{{CONTEXT}}

Review the repository changes against base revision {{BASE}} for correctness bugs and security issues only. Read the actual code on disk and inspect targeted diffs with Git. Do not request or print the complete repository diff when targeted file diffs are sufficient.

Changed paths:
{{CHANGED_PATHS}}

Diff statistics:
{{DIFF_STAT}}

Return one structured finding for each real defect. Use a stable descriptive id. Include severity, path, optional line, concrete failure scenario, defect, required change, and whether repair is recommended. HIGH findings always recommend repair. Recommend repair for a MEDIUM only when the correction is small, low-risk, and inside this change's scope. LOW findings never recommend repair. Severity scale: HIGH = wrong behavior, data loss, security, a broken gate, or shipping failed work; MEDIUM = a real defect with a workaround or a narrow blast radius; LOW = style or cleanup. Rank most-severe first. Return an empty findings array when there is no real defect.
