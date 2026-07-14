# Task-graph reference

The task graph is Sigil's public contract between agreed requirements and implementation. A code assistant, `plan`, or `probe` may produce it. Sigil validates the document, and `implement` consumes the normalized graph.

Print the current machine-readable JSON Schema with:

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
| `contractVersion` | Yes | Contract version required by the installed runtime. Read it from the emitted schema. |
| `project` | Yes | Short lowercase kebab-case project slug. It is not a filesystem path. |
| `goal` | Yes | Overall observable outcome for the graph. |
| `architecture` | Yes | Selected ownership boundary, state flow, dependency direction, and approach. |
| `constraints` | Yes | Requirements every task must preserve. The array may be empty. |
| `nonGoals` | Yes | Work explicitly excluded from the graph. The array may be empty. |
| `tasks` | Yes | Nonempty task array. Dependency order controls execution. |

## Task fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Stable task identifier referenced by dependencies and consumed interfaces. |
| `title` | Yes | Short human-readable task title. |
| `summary` | Yes | Task outcome and the accepted design context needed to implement it. |
| `dependencies` | No | Task identifiers that must complete first. Defaults to an empty array. |
| `interfaces` | Yes | Produced outputs and consumed outputs that define dependency contracts. |
| `acceptanceCriteria` | Yes | Nonempty observable outcomes that determine whether the task is satisfied. |
| `verification` | Yes | Nonempty focused checks that can prove the acceptance criteria. |
| `diagrams` | No | Diagrams that clarify the task. Defaults to an empty array. |
| `files` | Yes | Expected repository file actions and details. |

### Interfaces

`interfaces.produces` contains a stable `name` and behavioral `description` for each output a task guarantees to its dependents. `interfaces.consumes` contains the producer `taskId`, output `name`, and a description of how the current task uses it.

Every dependency must supply at least one consumed interface. The named output must exist on the producer, and a task cannot consume from a task it does not depend on. Produced names must be unique within their task.

### Verification

A command check has `kind: "command"`, a `command`, and the `expected` result. A manual check has `kind: "manual"`, a `procedure`, the `expected` observation, and a `rationale` explaining why deterministic automation is unsuitable.

Generated verification guides the coder and supplements configured gates. Configured gates remain the workflow's deterministic authority.

## File fields

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | Yes | Repository-relative file path. Validation resolves it against `--repo`. |
| `action` | Yes | One of `create`, `modify`, or `delete`. |
| `details` | Yes | Nonempty list anchored to stable symbols or structural locations. |

File entries are evidence-backed guidance, not a restrictive allowlist. Implementation may change additional files when correctness requires it, but it must preserve the graph goal, architecture, constraints, non-goals, interfaces, and acceptance criteria and report the deviation.

## Validation

Structural validation rejects missing required context, unsupported verification variants, malformed interfaces, unknown fields, invalid project slugs, empty required strings, and unsupported file actions.

Semantic validation requires unique task identifiers, known and acyclic dependencies, valid interface relationships, and unique produced interface names. When `--repo` is supplied, every file path must resolve inside that repository.

## Execution semantics

Tasks run in deterministic dependency order. A task is not runnable until every dependency has completed. A failed task prevents dependent tasks from running.

Produced interfaces and acceptance criteria are authoritative boundaries. Architecture, constraints, and non-goals apply across the graph. File details describe the plan's expected mechanism and may be corrected when current repository evidence supports a better implementation without changing the accepted outcome.
