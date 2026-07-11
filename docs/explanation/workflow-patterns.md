# Workflow patterns

Workflow patterns are reusable orchestration shapes built from Sigil primitives. A prompt pattern is one agent move. A workflow pattern arranges several moves, agents, artifacts, gates, or branches. A pattern becomes a sigil when you give it typed inputs, agent choices, prompts, artifact paths, gates, and a return shape.

Use these patterns when the task is large enough to benefit from orchestration. Do not turn a seconds-long check into a multi-agent workflow just because the pattern exists.

## Parallel analysis and synthesis

Use several isolated agents to analyze a question, then have a fresh agent synthesize the reports.

```text
question
  -> independent reports
  -> synthesis
  -> recommendation
```

Use this when the task benefits from breadth, disagreement, or model specialization: advice, research, design choices, large reviews, or model comparison. Watch for branches that are not truly independent. If every branch would read the same tiny source, answer directly instead.

## Sequential deep investigation

Reuse one agent over several prompt steps so it can build context, follow leads, and revise its view.

```text
question
  -> explore
  -> hypotheses
  -> verify or falsify
  -> deepen
  -> report or plan
```

Use this for unfamiliar systems, subtle bugs, comprehensive plans, and complex explanations. It is the right shape when depth matters more than independent viewpoints. If independence matters, use separate agents instead.

## Broad exploration followed by deep analysis

Use several smaller or faster agents to map the space, then give their findings to a stronger agent for deeper analysis.

```text
question
  -> broad exploration
  -> lead map
  -> deep analysis
  -> report or plan
```

Use this when the relevant surfaces are unknown, such as a large repo, ambiguous request, or incident investigation. The broad pass maps leads; the deep pass verifies and decides.

## Creative generation plus verification

Use a creative model to generate options, then use verification-oriented agents to test those options against facts, code, docs, constraints, or current sources.

```text
goal
  -> generate options
  -> verify or falsify options
  -> compare survivors
  -> recommendation
```

Use this for architecture decisions, product strategy, API design, workflow design, or naming when constraints matter. Keep generation and verification separate so attractive ideas still have to survive evidence.

## Generate, critique, repair

Have one agent create an artifact, a fresh agent critique it, and a repair step fix the important findings. Add a deterministic validation step when possible.

```text
requirements
  -> draft artifact
  -> critique
  -> repair
  -> validate
  -> final artifact
```

Use this for docs, plans, prompts, scripts, workflow files, and specs. Keep the critique scoped to the artifact's purpose; otherwise the repair step turns into open-ended rewriting.

## Classify and route

Ask for a controlled classification, then let deterministic code choose the next path.

```text
input
  -> classify
  -> route
  -> specialized workflow
```

Use this for issue triage, inbox processing, support flows, and deciding whether to plan, decompose, research, answer, or stop. The categories should be few, clear, and tied to different actions.

## Evidence bundle then execution

First turn messy input into a grounded bundle of user intent, verified facts, assumptions, constraints, and open questions. Then feed that bundle into a planning, research, advice, or implementation workflow.

```text
messy input
  -> requirements extraction
  -> verify facts
  -> ask targeted questions
  -> bundle
  -> downstream workflow
```

Use this when the request is important but still evolving. Preserve the user's words separately from interpreted requirements, and ask only questions that change the next action or safety.

## Gate and repair

Run a deterministic check. If it fails, ask an agent to repair the work, then run the check again.

```text
artifact or code
  -> deterministic gate
  -> repair if red
  -> rerun gate
  -> pass or issue
```

Use this for code, generated JSON, workflow files, structured docs, and other artifacts with clear validation. The gate owns pass/fail. The agent owns repair.

## Plan, execute, review

A planner produces a task graph, an implementer executes it, deterministic gates check it, and a fresh reviewer reviews the result.

```text
intent
  -> plan
  -> implement tasks
  -> gates
  -> review
  -> delivery decision
```

Use this for software engineering changes that fit one pull request. Keep acceptance criteria outcome-based, use a fresh reviewer, and keep publish or merge decisions outside the implementation step.

## Decompose and dispatch

Break a large mission into ordered work items. The backlog-authoring step owns the backlog prompts and shared backlog contract; dispatch owns dependency-ordered delivery. Each item is planned, implemented, reviewed, and delivered in dependency order through the public software-change workflow API.

```text
mission
  -> ordered backlog
  -> plan item
  -> implement item
  -> review item
  -> publish or merge
  -> next item
```

Use this for multi-PR work, migrations, and phased implementation. Each item should be shippable on its own, and dependency order should be explicit.
