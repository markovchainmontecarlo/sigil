---
name: sigil-brief
description: "Author a brief that hands agentic planning to Sigil: the outcome, decision hierarchy, non-goals, and completion checks from an accepted developer conversation, packaged for software-change --brief or plan --brief."
---

# Sigil brief authoring

Use this skill for agentic development when the planning input does not exist yet. The current code assistant owns the development conversation and distills it into a brief; Sigil's planners own the investigation and the task graph. Author a task graph with `sigil-task-graph` instead when the assistant already holds the file-level truth and the user has not asked Sigil to plan.

Use [SIGIL_USAGE.md](../../SIGIL_USAGE.md) for exact commands and authority boundaries.

## Start from accepted context

Derive every section from what the user actually said across the conversation. The brief restates their intent; it never smuggles in decisions they did not make. Verify concrete claims about current files, behavior, and dependencies before recording them as findings.

## What a brief carries

A brief states outcomes and boundaries, not mechanisms. It carries:

- the outcome as one testable scenario, written in the user's voice: what someone can do when this ships;
- the decision hierarchy that orders competing solutions, so planners can settle judgment calls without asking;
- named non-goals, so settled decisions are not replanned;
- completion as observable checks, each verifiable by command or by inspection;
- verified findings as referenced context: file paths, observed behavior, constraints. Planners may correct findings with evidence; they may not cross the stated boundaries. State a boundary that must hold through any acceptable plan as an invariant.

A brief that prescribes mechanism is a task graph wearing planning context. Move mechanism to `sigil-task-graph` and `--task-file`, or delete it.

## Write the brief

1. Write `brief.md` with the sections above, in that order.
2. When the conversation produced real investigation, write `findings.md` beside it and reference it from the brief; keep one concern per file.
3. Place the files in a durable location in the target repository, such as an ignored briefs or handoffs directory. Do not write them under operating-system temporary storage.

## Check and hand off

Before finishing, sweep the files: no mechanism prescriptions, no credential plaintext, no counts, versions, or timestamps that decay. Fix any hit.

Then hand off with the brief as planning context and a one-line intent that names the change:

```sh
sigil software-change --repo /path/to/repo --intent "<one line naming the change>" --brief /path/to/brief.md
```

Use `plan --brief` instead when planning is the requested output. The intent names the change; the brief carries the accepted context.
