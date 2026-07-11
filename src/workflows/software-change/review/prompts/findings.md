{{CONTEXT}}

Review the repository changes against base revision {{BASE}} for correctness bugs and security issues only. Read the actual code on disk and inspect targeted diffs with Git. Do not request or print the complete repository diff when targeted file diffs are sufficient.

Changed paths:
{{CHANGED_PATHS}}

Diff statistics:
{{DIFF_STAT}}

For each finding give: SEVERITY, file:line, the concrete failure scenario, and a one-line statement of the defect. Severity scale: HIGH = wrong behavior, data loss, security, a broken gate, or shipping failed work; MEDIUM = a real defect with a workaround or a narrow blast radius; LOW = style or cleanup. Rank most-severe first. If you find nothing real, say so. Do not invent findings to fill space.

Write your findings to {{OUT_FILE}}.
