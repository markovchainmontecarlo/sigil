Investigate the repository further and enrich this task graph in place at {{OUT_FILE}}.

The reader is the implementer: an agent that will execute one task at a time with only the task's own content in front of it. Enrich every task with whatever would make it clear what needs implementing. Every field is on the table:

- summaries that carry the context an implementer needs: what the surrounding code does, what changes, and what must not change
- a good diagram where one would help, in ASCII inside diagrams[]
- robust, runnable acceptance criteria that state observable OUTCOMES, never mechanism mandates — the implementer owns how, and a criterion that hardcodes an implementation choice removes the implementer's judgment exactly where it is most needed
- details[] on each files[] entry saying what to change in that file, anchored to what you actually find in the code
- corrected paths, missing files, missing dependency edges, and anything else you discover

Add detail and context, never scope: no new work beyond the intent below. Keep the contract shape, repo-relative paths, and valid dependency ids. Be dense, not verbose.

INTENT:
{{INTENT}}

TASK GRAPH:
{{TASK_GRAPH}}
