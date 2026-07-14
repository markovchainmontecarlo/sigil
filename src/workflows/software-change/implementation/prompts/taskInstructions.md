## Task contract

For every task in this session:

- Read the actual code before editing and verify the task's claims against HEAD.
- Treat acceptance criteria and produced interfaces as authoritative outcome boundaries.
- Use consumed interfaces as the dependency contract.
- Run focused verification while implementing. Configured global gates remain authoritative.
- Treat file guidance as advisory. Follow repository dependencies when correctness requires another file, but do not broaden the task's outcome.
- Prefer a better mechanism when repository evidence disproves a prescribed implementation detail. Preserve the outcome and report the deviation.
- Keep configured `update: true` context files accurate with the smallest in-place edit. Treat `update: false` context as read-only unless the task declares it as output.
- Complete the implementation before replying. State what changed and identify justified deviations.
