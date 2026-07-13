# Task-graph reference

The task graph is Sigil's public contract between agreed requirements and implementation. A code assistant, `plan`, or `probe` may produce it. Sigil validates the document, and `implement` consumes the normalized graph.

Print the machine-readable JSON Schema with:

```sh
sigil task-graph schema
```

Validate a document against a repository with:

```sh
sigil task-graph validate --repo /path/to/repo /path/to/task-graph.json
```

## Document fields

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | No | Optional schema reference for editor support. |
| `contractVersion` | Yes | Task-graph contract version understood by the runtime. |
| `project` | Yes | Short lowercase kebab-case project slug. It is not a filesystem path. |
| `goal` | No | Overall observable outcome for the graph. |
| `tasks` | Yes | Nonempty task array. Dependency order controls execution. |

## Task fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Stable task identifier referenced by dependencies. |
| `title` | Yes | Short human-readable task title. |
| `summary` | Yes | The task outcome and decision context. |
| `dependencies` | No | Task identifiers that must complete first. Defaults to an empty array. |
| `acceptanceCriteria` | Yes | Nonempty observable outcomes that determine whether the task is satisfied. |
| `diagrams` | No | Diagram references or content required by the task. Defaults to an empty array. |
| `files` | Yes | Expected repository file actions and details. |

## File fields

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | Yes | Repository-relative file path. Validation resolves it against `--repo`. |
| `action` | Yes | One of `create`, `modify`, or `delete`. |
| `details` | Yes | Nonempty list describing the expected outcome for that file. |

File entries describe the expected changes, but they are not a restrictive allowlist. Implementation should begin with the declared files and may change additional files when they are required to complete the task correctly. It must preserve the task goal and acceptance criteria and report deviations.

## Structural validation

Structural validation requires supported contract fields and types, a valid project slug, at least one task, nonempty required strings, supported file actions, and nonempty acceptance criteria and file details. Unknown fields are rejected so misspellings do not silently change the contract.

Optional dependency and diagram arrays are normalized to empty arrays. The normalized graph used by implementation always contains both fields.

## Semantic validation

Semantic validation requires unique task identifiers, known dependency identifiers, and an acyclic dependency graph. When `--repo` is supplied, every file path must resolve inside that repository.

## Execution semantics

Tasks run in deterministic dependency order. A task is not runnable until every dependency has completed. A failed task prevents dependent tasks from running.

Acceptance criteria define the required outcomes. Summaries, file details, and implementation mechanisms may change when they do not match current repository evidence. A correction may not expand the task goal, skip an outcome, or weaken verification.

## Complete example

```json
{
  "contractVersion": 1,
  "project": "add-health-check",
  "goal": "Expose a verified application health check",
  "tasks": [
    {
      "id": "health-endpoint",
      "title": "Add the health endpoint",
      "summary": "Expose application health without leaking private runtime details.",
      "acceptanceCriteria": [
        "The application returns a successful health response",
        "The response contains no credentials or private configuration"
      ],
      "files": [
        {
          "path": "src/server/health.ts",
          "action": "create",
          "details": [
            "Implement the health response using the existing server conventions"
          ]
        }
      ]
    }
  ]
}
```

This example omits empty `dependencies` and `diagrams`; validation adds them to the normalized graph.
