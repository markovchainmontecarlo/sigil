Evaluate the completed repository migration against the target architecture.

Target architecture:
{{TARGET}}

Migration goal:
{{GOAL}}

Complete committed diff:
{{DIFF}}

Known finding ids and repair attempts:
{{KNOWN_FINDINGS}}

Return a blocking verdict only when the repository still violates a stated target or has a material ownership, dependency-direction, or cohesion defect. Every finding must have a stable short id based on the affected boundary and defect, cite concrete diff evidence, and name the required change. Reuse an existing id when reporting the same defect again. Do not request compatibility layers unless the target requires them.
