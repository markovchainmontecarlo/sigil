# Configure provider profiles

Use placeholder names. Profile names appear in status and telemetry, so never encode an account identity or secret in them.

## Subscription only

```sh
sigil profile add subscription --provider codex --class subscription --home /path/to/provider-managed/codex-home --concurrency 1 --reserve-floor 20
sigil profile add subscription --provider claude --class subscription --default-config --concurrency 1
sigil profile status --json
```

Use `--default-config` for the Claude login managed by the ordinary local
`claude` command. Use `--config-dir <dir>` only for a separately initialized
Claude configuration directory.

Keep every metered profile absent or disabled. Complete login with the provider's own tool. `discover-env` verifies prerequisites, not authentication. Provider-managed paid overage must also be disabled with the provider if a strict subscription-only boundary is required.

## Manual metered access

```sh
sigil profile add manual --provider codex --class metered-api --home /path/to/provider-managed/codex-home --mode manual --start-limit 1 --token-limit 10000 --reservation-tokens 5000
sigil profile add manual --provider claude --class metered-api --credential-source ANTHROPIC_API_KEY --mode manual --start-limit 1 --admission-usd 5 --operation-usd 1
sigil profile next codex:manual --agents 1
```

The credential-source argument names an environment binding; it is not the credential. Use `profile next` for a bounded Claude manual assignment.

## Bounded overflow and automatic access

```sh
sigil profile add overflow --provider claude --class metered-api --credential-source ANTHROPIC_API_KEY --mode overflow --start-limit 2 --admission-usd 10 --operation-usd 2
sigil profile add automatic --provider claude --class metered-api --credential-source ANTHROPIC_API_KEY --mode automatic --start-limit 2 --admission-usd 10 --operation-usd 2
sigil profile inspect claude:overflow --json
sigil profile status --provider claude --json
```

Overflow becomes eligible only after subscriptions are ineligible. Automatic authorization permits direct selection but still enforces admission and per-operation limits. Disable a profile to revoke future assignments. An assigned profile stays fixed for the agent lifetime; rerouting waits for process cleanup and reservation release.
