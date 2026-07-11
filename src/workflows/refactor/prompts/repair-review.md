Repair the blocking review findings. Follow the dependency closure required by the intent, but do not modify protected paths.

Preserve the refactor intent and invariants. Address only findings supported by the diff. Do not weaken tests or change public behavior to make a finding disappear.

Each finding owns its own repair budget. The history below records prior repair attempts for findings that may have returned. Resolve every current blocking finding directly and preserve fixes for earlier findings.

## Repair history

{{REPAIR_HISTORY}}

STRUCTURE REVIEW:
{{STRUCTURE_REVIEW}}

BEHAVIOR REVIEW:
{{BEHAVIOR_REVIEW}}
