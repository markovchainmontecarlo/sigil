# Prompt patterns

Prompt patterns are reusable operations inside a workflow. They are usually too small to be top-level workflows, but they are building blocks for reliable orchestration.

A prompt pattern should tell the agent what to inspect, what judgment to make, what evidence to include, and what output shape to produce. Patterns become powerful when a workflow arranges them: verify first, generate next, critique with a fresh agent, repair under a deterministic gate, then synthesize.

Use prompt patterns for single steps or short sequences. When the work needs multiple agents, branching, gates, artifacts, or retries, use a workflow pattern or custom workflow.

Checked-in workflow prompt templates live with the feature that owns the stage using them. Planning prompts live under `src/workflows/software-change/planning/prompts/`, implementation prompts under `src/workflows/software-change/implementation/prompts/`, review prompts under `src/workflows/software-change/review/prompts/`, and backlog-authoring prompts under `src/workflows/breakdown/prompts/`. Keep reusable examples in documentation, not as parallel prompt trees.

## Verify or falsify

Force an agent to test claims against evidence before acting. This is useful even when there is no failing gate. The point is to make the agent read, search, and form its own view instead of executing a stale brief.

Use when a workflow depends on user claims, previous agent claims, generated plans, design assumptions, source citations, or current external facts.

Avoid when the assistant already has the needed evidence in context and the check would only restate it.

Template:

```text
Read the sources needed to evaluate these claims. For each claim, return:
- claim
- verdict: VERIFIED, FALSIFIED, or UNKNOWN
- evidence
- correction, if falsified

Do not treat the brief as authority. Trust the sources you inspect.

Claims:
{{CLAIMS}}
```

## Explore before deciding

Ask the agent to investigate the system first, then recommend. The prompt should ask for current state, relevant files or sources, constraints, viable options, and the reason for the recommendation.

Use when the right answer depends on repo shape, runtime behavior, docs, or source evidence.

Avoid when the decision is already determined by explicit user instruction or a simple local fact.

Template:

```text
Investigate before recommending. Read the relevant sources and report:
1. Current state
2. Relevant files, commands, docs, or sources
3. Constraints and invariants
4. Viable options
5. Recommendation and why it beats the alternatives

Question:
{{QUESTION}}
```

## Generate alternatives

Ask for distinct viable options before choosing. This works best with a creative model or a model assigned to propose approaches without defending the first idea.

Use when there are several plausible designs, names, strategies, or workflows.

Avoid when the task has one obvious required action and alternatives would add noise.

Template:

```text
Generate three distinct viable approaches. For each one, include:
- approach
- when it works best
- cost or risk
- what would falsify it

Do not choose yet. Make the options genuinely different.

Goal:
{{GOAL}}
```

## Critique

Ask an agent to find defects, gaps, risks, unsupported claims, and failure modes in an artifact. Critique works best with a fresh agent that did not create the artifact.

Use when an artifact will guide future work or be trusted by another agent or human.

Avoid when the artifact is disposable and the cost of review is higher than the cost of being wrong.

Template:

```text
Review this artifact for correctness, unsupported claims, missing constraints, and failure modes.
Return findings ordered by severity. For each finding, include:
- severity
- issue
- evidence
- why it matters
- suggested correction

Artifact:
{{ARTIFACT}}
```

## Resolve disagreement

Given competing positions, ask an agent to investigate and choose. The output should name the question in dispute, the options, the evidence for and against each option, and the recommended resolution.

Use when prior agents disagree or when the workflow has competing viable approaches.

Avoid when the disagreement is only wording and does not change the next action.

Template:

```text
Resolve this disagreement against evidence. For each disputed question, return:
1. Question in dispute
2. Options
3. Evidence for and against each option
4. Recommendation
5. Why the recommendation beats the alternatives

Disagreement:
{{DISAGREEMENT}}
```

## Synthesize

Combine several reports into one result. A synthesis prompt should preserve disagreement instead of flattening it. Ask for agreement, disagreement, evidence, uncertainty, and the final recommendation.

Use after independent analysis, broad exploration, model comparison, or multi-source research.

Avoid when there is only one source and no real integration work.

Template:

```text
Synthesize these reports. Do not average them together. Return:
- points of agreement
- points of disagreement
- strongest evidence
- unresolved uncertainty
- final recommendation
- next action

Reports:
{{REPORTS}}
```

## Validate and repair

Ask an agent to fix an artifact against a schema, contract, validation errors, or acceptance criteria. The prompt should forbid changing scope just to satisfy the validator.

Use when a deterministic check produced concrete errors.

Avoid when the validator is vague or when the artifact needs a design decision rather than repair.

Template:

```text
The artifact failed validation. Repair the artifact without changing its scope.
Work in this order:
1. Read the artifact in full.
2. Read every validation error.
3. Fix the source of each error.
4. Preserve the intended meaning and contract.

Validation errors:
{{ERRORS}}

Artifact:
{{ARTIFACT}}
```

## Deepen

Reuse the same agent and ask it to follow the strongest leads from its prior answer. Deepening is useful when the workflow needs a large context window filled with repo facts, source comparisons, or investigation results.

Use when the previous answer exposed uncertainty, leads, or hypotheses worth investigating.

Avoid with a fresh agent unless independence matters more than accumulated context.

Template:

```text
Use your previous findings as context. Choose the two most important uncertainties or leads.
Investigate them further, then update your conclusion.
Return:
- what you investigated
- what changed from your previous view
- evidence
- updated conclusion
```

## Adversarial review

Ask an agent to assume a proposal is wrong and find the strongest failure modes. This is useful for high-risk plans, migrations, security-sensitive changes, and decisions with costly mistakes.

Use when confidence is high but the cost of being wrong is also high.

Avoid when the workflow needs constructive design work first.

Template:

```text
Assume this proposal is wrong. Find the strongest reasons it could fail.
Focus on correctness, safety, hidden dependencies, operational risk, and second-order effects.
For each failure mode, include evidence and a mitigation.

Proposal:
{{PROPOSAL}}
```

## Classify

Ask for a small routing decision from a controlled set of options. This pattern is strongest with structured output.

Use when the workflow must choose between known paths.

Avoid when the categories are unclear or when the classification does not change the next step.

Template:

```text
Classify the input into exactly one of these categories:
{{CATEGORIES}}

Return the category and one sentence explaining why. If none fits, choose NEEDS_CLARIFICATION.

Input:
{{INPUT}}
```

## Extract evidence

Ask an agent to collect relevant evidence without recommending yet. This separates gathering from deciding.

Use before synthesis, critique, or decision steps.

Avoid when the evidence set is already complete and cited.

Template:

```text
Extract evidence relevant to this question. Do not recommend yet.
For each evidence item, include:
- source
- exact fact
- why it matters
- confidence

Question:
{{QUESTION}}
```

## Compare options

Ask an agent to compare options against explicit criteria before recommending.

Use when a decision should be traceable to tradeoffs.

Avoid when there are no real options or the criteria are unknown.

Template:

```text
Compare these options against the criteria below. Return a table, then a recommendation.
For each option, include strengths, weaknesses, risks, and what would change the decision.

Criteria:
{{CRITERIA}}

Options:
{{OPTIONS}}
```

## Constrain output

Ask an agent to produce a specific artifact shape, schema, or section list.

Use when a later deterministic step or human reader depends on structure.

Avoid over-constraining creative or exploratory steps before the right shape is known.

Template:

```text
Produce the artifact in exactly this structure:
{{STRUCTURE}}

Rules:
- Include every required section.
- Do not add extra sections unless explicitly allowed.
- Mark unknowns as UNKNOWN instead of inventing values.

Task:
{{TASK}}
```

## Ask targeted questions

Ask only questions that would change the workflow path, scope, or safety of the next step.

Use when missing information blocks a reliable plan or execution.

Avoid broad interviews. If the workflow can safely proceed with an assumption, state the assumption and continue.

Template:

```text
Identify only the questions whose answers would change the next action, scope, or safety of the workflow.
For each question, include why it matters and what you would assume if unanswered.

Context:
{{CONTEXT}}
```

## Decision record

Turn analysis into a durable decision artifact. A decision record usually includes context, decision, alternatives considered, consequences, risks, and follow-up checks.

Use when a decision should be preserved for future readers or agents.

Avoid for small local choices that are clear from the code or final artifact.

Template:

```text
Write a decision record with these sections:
- Context
- Decision
- Alternatives considered
- Consequences
- Risks
- Follow-up checks

Analysis:
{{ANALYSIS}}
```

## Requirements extraction

Turn messy user input into goals, constraints, non-goals, assumptions, open questions, and acceptance criteria. This preserves user intent before a later planning or implementation workflow consumes it.

Use when the user has described a larger desired outcome but the work is not ready to plan or implement.

Avoid when the user already provided a precise task and acceptance criteria.

Template:

```text
Extract a requirements bundle from the notes. Preserve the user's intent.
Return:
- goals
- constraints
- non-goals
- assumptions
- verified facts
- open questions
- acceptance criteria

Notes:
{{NOTES}}
```

## Repair loop

After a deterministic failure, ask an agent to fix all failures, rerun the command, read the output, and keep fixing until it observes success. The deterministic gate owns the pass/fail decision.

Use when the workflow can safely ask an agent to edit and rerun a command.

Avoid when the failure needs a human decision or the command is destructive.

Template:

```text
Fix all failures below. Do not weaken tests, remove checks, or change scope to make the command pass.
After editing, run the command yourself, read the output, and keep fixing until you observe it pass.

Command:
{{COMMAND}}

Failure log:
{{LOG}}
```
