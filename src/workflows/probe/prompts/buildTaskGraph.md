Build an implementation task graph from the confirmed probe findings. Work in this order:

1. Use only findings supported by the probe evidence. Do not turn weak signals into implementation work.
2. Select one architecture and create one coherent task per independently verifiable product improvement.
3. Prefer behavior, command, validation, runner, configuration, install, or workflow changes over docs-only changes unless documentation is truly the product surface being fixed.
4. Record constraints and non-goals, and write acceptance criteria as observable outcomes that prove the improved user experience.
5. Name produced and consumed interfaces so every dependency has an explicit reason.
6. Add focused verification with an expected result for every task.
7. Write the task graph as JSON to {{OUT_FILE}}, with repo-relative files[].path values, stable symbol or structural anchors, and valid dependency ids. Match this contract:

{{CONTRACT}}

GOAL / INTENT:
{{INTENT}}

CONFIRMED FINDINGS:
{{FINDINGS}}
