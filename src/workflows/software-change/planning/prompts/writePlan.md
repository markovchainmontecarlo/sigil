Turn your findings and decisions into a plan. Work in this order:

1. Break the work into tasks. Each task is one coherent unit that can be implemented and verified on its own. Order them so every task appears after the tasks it depends on.

2. For each task, write:
   - id: a short stable identifier, unique within this plan.
   - title: one line naming what the task does.
   - summary: one paragraph on what changes and why, carrying the recommendation you chose for any judgment call this task settles.
   - dependencies: the ids of the tasks that must land first, or empty.
   - acceptanceCriteria: concrete behavioral checks that prove the task works, written as observable outcomes rather than implementation notes.
   - diagrams: an ASCII diagram where it makes the change clearer, otherwise omit.
   - files: every file the task touches. For each file give its repo-relative path, an action of create, modify, or delete, and a details array. In details, anchor each change to a concrete symbol you confirmed, and to the exact line number where the change goes. Line numbers are required on every modify and delete detail.

Before you record any line number, open and read the full file, not just a search hit, so the numbers are accurate. Anchor every path, symbol, and line number to what you actually confirmed while investigating, so the synthesizer and implementer can rely on them.

Write only your plan markdown to {{OUT_FILE}}.
