# Provider routing

The repository says what kind of agent a workflow needs. The local operator decides which account profile may satisfy it and whether metered billing is authorized. Keeping those decisions separate prevents a repository from enabling someone else's API spend.

Assignment is lazy. Effective configuration describes deterministic repository values and candidate policy. `profile status` reports current, possibly unknown, eligibility. Agent creation selects a subscription profile or reserves a metered profile and produces a resolved assignment. Subscription capacity evidence is informational; metered budgets and reservations can change between inspection and assignment.

Enabled subscription profiles are preferred and selected without local capacity blocking. The provider owns subscription capacity enforcement. Metered access exists only through an explicitly created and enabled profile with a routing mode, admission bound, and hard operation bound. Manual access needs a bounded one-shot selection where supported. Overflow waits until subscriptions are ineligible. Automatic access is immediately eligible within its limits. Missing authentication or provider failure never authorizes a credential profile.

Codex and Claude share the project binding but not the adapter. Codex uses ACP. Claude subscription runs the local CLI in an owned PTY with its selected configuration directory; Claude metered access uses the Agent SDK with its selected credential source. Transport is resolved assignment metadata, not a public provider name. Requested approval, sandbox, and network policies are mapped to actual adapter behavior; Sigil does not claim equivalent sandbox enforcement where none exists.

Codex can report stable rate-limit evidence and supports explicit subscription priming. Priming is never an implicit read or dispatch effect. Claude has no stable subscription-capacity interface, so its capacity remains `unknown`, never an invented percentage. Provider-specific limits remain provider-specific even though lifecycle events and safe assignment fields are common.

Each run writes one redacted effective-configuration snapshot at its root. Assignment, prompt delivery and acceptance, usage, release, and classified failure events contain allowlisted metadata only. Recovery state persists only the identity needed to resume or settle ownership; telemetry is not another recovery authority.
