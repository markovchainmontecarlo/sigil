The refactor changed caller-protected paths. Repair the working tree now without discarding valid unprotected work.

Intent:
{{INTENT}}

Protected paths:
{{PROTECTED_PATHS}}

Structured failure:
{{FAILURE}}

Current complete diff:
{{DIFF}}

Remove, revert, or relocate every protected-path change. Preserve the intended behavior and keep the working tree buildable. Unprotected dependency discovery is allowed.
