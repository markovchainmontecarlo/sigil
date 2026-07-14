Plan one cohesive change. If the request contains separable outcomes, say so and define the boundary of this plan.

Build a file responsibility map before decomposing tasks. Trace ownership, state flow, callers, tests, configuration, and deterministic gates. Prefer an established repository pattern when it fits. Recommend a focused redesign when the current surface is the wrong shape.

Make each task the smallest cohesive unit worth implementing, verifying, committing, and reviewing on its own. Fold setup into the task that needs it. For every dependency, name the produced interface and the consumed interface that justify the edge. State acceptance as observable behavior and verification as a focused command or a justified manual procedure.

Do not use placeholders, undefined names, vague error-handling instructions, or references such as “same as the previous task.” Apply DRY, YAGNI, and test-first reasoning where they clarify a concrete design choice.

End with a self-review that checks requirement coverage, placeholder text, task size, and consistent interface and symbol names across tasks.
