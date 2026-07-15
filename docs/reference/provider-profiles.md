# Provider profile reference

The version 1 profile command contract manages operator-local routing policy for `codex` and `claude`.

```sh
sigil profile list --json
sigil profile status --provider claude --json
sigil profile inspect claude:subscription --json
sigil profile enable claude:subscription --json
sigil profile disable claude:subscription --json
sigil profile remove claude:subscription --json
sigil profile next codex:manual --agents 1 --json
sigil profile rearm claude:subscription --json
sigil profile prime codex:subscription --repo /path/to/repo --json
```

Selectors are `provider:name`; a bare name is accepted only when unique across providers. `list` returns `{version, kind:"profile-list", profiles}`. `inspect` returns `{version, kind:"profile-inspection", profile, state}`. `status` returns `{version, kind:"profile-status", profiles}`. Mutations return `{version, kind:"profile-operation", operation, profile}` plus action-specific `agents`, `support`, or `outcome`.

A safe profile contains `version`, `provider`, `name`, `qualifiedIdentity`, `accessClass`, `enabled`, optional `mode`, `admissionLimit`, `operationLimit`, and a provider-specific safe `policy`. Access classes are `subscription` and `metered-api`. Metered modes are `manual`, `overflow`, and `automatic`. Manual profiles require `profile next`; overflow follows ineligible subscriptions; automatic may be selected directly. API access is never inferred or silently enabled.

Enabled subscription profiles are selected without local capacity admission, reservations, circuits, or rearm requirements. Codex metered admission can limit starts, runtime, or tokens; its operation reservation limits tokens. Claude metered admission limits starts or observed USD, and every operation requires a hard USD limit. Provider-managed subscription overage is provider policy, not selection of a Sigil metered profile.

State reports metered profile activity, active assignments, circuit state, and bounded usage. Metered reservations bind a profile to a process owner until cleanup, and metered circuits prevent admission until eligible recovery. Codex subscription status reports live provider capacity as informational evidence; it does not control admission. Authentication may be `unknown`; Claude subscription capacity remains `unknown` because no stable probe supplies a percentage.

Capabilities cover transport, authentication and capacity probes, usage, approval, sandbox, network control, and priming. Codex uses `codex-acp`. Claude subscription uses `claude-cli-pty`; Claude metered access uses `claude-agent-sdk`. Claude priming is reported as unsupported rather than simulated. One-shot selection is available for eligible Claude profiles.

Registry corruption, unsupported versions, unsafe permissions, unverifiable locks or owners, unresolved credential sources, exhausted metered budgets, metered circuits, authentication failures, provider capacity failures, and unaccepted prompts produce classified errors. Public failure projections expose only classification, disposition, fingerprint, and safe operation or RPC metadata.
