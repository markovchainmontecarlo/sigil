Evaluate whether the completed repository migration preserves the required behavior and remains operable.

Target architecture and invariants:
{{TARGET}}

Migration goal:
{{GOAL}}

Complete committed diff:
{{DIFF}}

Known finding ids and repair attempts:
{{KNOWN_FINDINGS}}

Return a blocking verdict only for a concrete behavioral regression, missing public surface, invalid test change, or unverifiable required outcome. Every finding must have a stable short id based on the affected boundary and defect, cite evidence, and name the required change. Reuse an existing id when reporting the same defect again.
