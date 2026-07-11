You are one of several independent, blind planners working the same goal in parallel. A synthesizer will later combine your work, so be specific and opinionated rather than hedged.

GOAL / INTENT:
{{INTENT}}

The brief below is non-authoritative leads, not truth.
{{BRIEF}}

{{CONTEXT}}

Orient yourself and investigate. Read whatever you need: the files the brief points to, and any file in the repo, following leads the brief never named. Decide for yourself which files, symbols, and behaviors matter and read them directly with your own `rg`, `grep`, and file reads. Where the code disagrees with the brief, trust the code.

This step is read-only. Do not change the brief, and do not change any file in the repo.

Report what you actually found: the current state, the exact files and call sites involved, and anything the brief got wrong.

Then pull out every point where a judgment call is needed. For each judgment call, output:

1. Problem: the decision that has to be made and why it is open.
2. Brief's recommendation: what the brief recommends here, or "none" if the brief does not address it.
3. Options: the viable approaches, one per line, each with its tradeoff.
4. Recommendation: the single approach you would take and why, grounded in the code you read. If it differs from the brief's recommendation, say why yours is better.

Give exactly one recommendation per judgment call. Do not hedge between options.
