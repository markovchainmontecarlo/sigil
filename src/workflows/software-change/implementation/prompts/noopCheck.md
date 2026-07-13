Your previous turns for task {{TASK_ID}} — {{TASK_TITLE}} changed no files, even after a corrective retry. Exactly one of two explanations is true; decide which, with evidence:

1. The repository already satisfies every acceptance criterion, because earlier tasks in this change or prior commits did the work, so a no-op was the correct outcome.
2. It does not, and the no-op turns were vacuous.

Read the actual code at HEAD for each criterion:
{{ACCEPTANCE}}

For each criterion, cite file:line evidence that it already holds, or name concretely what is missing. Do not change any files. This is a verdict turn, not a work turn.

If any criterion is unproven, answer UNSATISFIED. End your reply with exactly one line, nothing after it:
NOOP-CHECK: SATISFIED|UNSATISFIED
