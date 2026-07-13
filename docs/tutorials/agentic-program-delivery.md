# Deliver a multi-change program

Use program delivery when one product goal requires several independently verifiable changes. `breakdown` creates the backlog contract. `dispatch` implements items in dependency order and can resume interrupted delivery.

Do not use dispatch merely to combine planning and implementation for one change. AI-assisted task graphs and `software-change` already cover that path.

## Create the backlog

Turn the mission into a durable backlog under the ignored run directory:

```sh
sigil breakdown --repo /path/to/repo --mission "Deliver the complete capability" --out /path/to/repo/.sigil/runs/program/backlog.json
```

Inspect the backlog before delivery. Each item should produce one independently verifiable outcome. Dependencies should express required order rather than merely preferred order.

## Choose delivery policy

Use `mergeWhenGreen` when every item is independently releasable and authorized to merge into the delivery base.

Use `integrationBranch` when item pull requests should accumulate on a program branch before one final pull request to main.

The delivery policy cannot change when the run resumes.

## Start dispatch

The following command accumulates item changes on an integration branch and leaves the final pull request open:

```sh
sigil dispatch --repo /path/to/repo --backlog /path/to/repo/.sigil/runs/program/backlog.json --policy integrationBranch --integration-branch feature/program --run-dir /durable/path/program-run
```

Dispatch calls the single-change workflow for each backlog item and preserves completed work across interruptions.

## Resume safely

Resume the recorded operation rather than starting another dispatcher:

```sh
sigil dispatch --resume /durable/path/program-run
```

Resume verifies the recorded run before continuing unfinished work. It does not replay completed items.

## Keep authority explicit

Dispatch can push branches, open pull requests, merge, and run a production verification gate according to policy. Obtain explicit authority for every selected external effect. Preparation and backlog validation do not imply delivery authority.

The [Sigil dispatch skill](../../skills/sigil-dispatch/SKILL.md) and [usage guide](../../SIGIL_USAGE.md) describe the delivery policies and recovery rules.
