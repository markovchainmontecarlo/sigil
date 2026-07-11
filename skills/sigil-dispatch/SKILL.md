---
name: sigil-dispatch
description: "Prepare or validate a dependency-ordered backlog and operate resumable Sigil dispatch with explicit delivery, integration-branch, publishing, merge, and production-effect authority."
---

# Sigil dispatch

Use this skill when one mission requires several dependency-ordered deliverables. Dispatch owns cross-item delivery, integration-branch accumulation, pull requests, merging, checkpoint resume, and delivery-base verification. It delegates each item change to `softwareChange`.

Read the backlog and dispatch sections of [SIGIL_USAGE.md](../../SIGIL_USAGE.md) before operating the workflow. Keep exact flags in that guide rather than copying them here.

## Start from the accepted state

- If the user has an accepted backlog, validate and dispatch it without running breakdown again.
- If only a mission exists, use `breakdown` to produce the backlog contract, inspect its validity, and then dispatch it.
- If a dispatch checkpoint exists, verify the backlog identity, delivery policy, delivery base, active item, branch, and recorded commit before resuming.
- Preserve accepted task graphs, existing item branches, delivered commits, and completed checkpoints. Do not replay finished work.

## Backlog readiness

Each deliverable item should have:

- one independently verifiable outcome;
- explicit dependencies;
- outcome-based acceptance criteria;
- enough context to plan the item without redesigning the whole mission;
- a boundary that can be reviewed and delivered as one change.

Use dependencies to express required order and leave unrelated items dependency-independent. Dispatch processes deliverable items serially, but execution order is not a reason to invent a false dependency.

## Choose delivery policy

Use `mergeWhenGreen` when every verified item is independently releasable and authorized to merge into the configured main branch.

Use `integrationBranch` when item pull requests should merge into an accumulating program branch. Choose whether completion stops at one final pull request to main or continues through final merge and a configured production gate.

The policy is part of the dispatch checkpoint identity. Do not change it during resume.

## Authority

Obtain explicit authority for the effects the selected policy can perform:

- pushing item branches;
- opening pull requests;
- merging item pull requests;
- opening or merging the final pull request;
- running a production verification gate.

Preparation, validation, and local inspection do not imply delivery authority.

## Operate and resume

1. Establish the target repository, remote delivery base, accepted backlog, and delivery policy.
2. Start or resume dispatch with one durable run context.
3. Monitor checkpoint state, item-owned artifacts, process progress, and target Git state.
4. Let actionable review findings and failed gates enter the workflow's bounded repair path.
5. Resume an interrupted active item from its recorded delivery stage and existing branch when the checkpoint proves ownership.
6. Verify the refreshed delivery base after every merge before advancing.
7. Report delivered items, the active or stopped stage, final pull-request state, production-gate outcome when configured, and unresolved issues.

Do not create a separate approval-first planning bundle before breakdown or dispatch. Ask only for authority or information that changes the delivery boundary.
