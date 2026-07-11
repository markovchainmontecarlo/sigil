The backlog JSON file at {{FILE}} failed deterministic backlog contract validation. Fix it. Work in this order:

1. Read {{FILE}} in full.

2. Resolve each validation error below without changing the intended backlog items:
{{ERRORS}}

3. Read repository context only when it is needed to preserve an item's intent or dependency relationship. Match this backlog contract exactly:

{{CONTRACT}}

4. Write valid, parseable backlog JSON back to {{FILE}}, preserving each item's scope and dependency meaning.
