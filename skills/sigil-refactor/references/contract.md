# Refactor contract

## Input

```ts
type RefactorInput = {
  repo: string;
  intent: string;
  brief?: string;
  focus?: string[];
  protectedPaths?: string[];
};
```

CLI mapping:

```text
repo   -> --repo <dir>
intent -> --intent <text>
brief  -> --brief <file>
focus          -> repeated --focus <path>
protectedPaths -> repeated --protected-path <path>
```

Example brief:

```markdown
# Refactor target

Move request parsing behind a cohesive command-adapter boundary.

## Invariants

- Public command behavior and exit codes remain unchanged.
- Existing task-graph validation remains authoritative.
- Prompt text stays in template files.

## Acceptance targets

- The entrypoint only selects and delegates commands.
- Command-adapter tests cover parsing and exit-code mapping.
- Typecheck and the full test suite pass.

## Exclusions

- Do not add a command-framework dependency.
- Do not retain duplicate legacy modules or compatibility wrappers.
```

## Result

```ts
type RefactorResult = {
  branch: string;
  planFile: string;
  structureReviewFile: string;
  behaviorReviewFile: string;
  eventsFile: string;
  changedFiles: string[];
  valid: boolean;
  issues: string[];
  failures: WorkflowFailure[];
  discoveries: Array<{ path: string; justification: string }>;
};

type WorkflowFailure = {
  kind: "authority" | "gate" | "review" | "provider" | "checkpoint";
  stage: string;
  evidence: string;
  paths?: string[];
  attempts: number;
  recoverable: boolean;
};
```

The generated plan contains a goal, invariants, and one to six ordered slices. Each slice has an ID, description, owned paths, and expected change.
