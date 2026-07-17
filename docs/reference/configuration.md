# Configuration reference

`sigil.config.json` records repository intent. `$SIGIL_HOME` records operator-owned provider profiles and routing state. Credentials remain owned by Codex or Claude and are never copied into project configuration.

## Project fields and defaults

The top-level fields are `agents`, `evals`, `workspace`, `context`, `plan`, `implement`, `review`, `probe`, `breakdown`, `dispatch`, `refactor`, and `migrate`. An agent binding has the same shape for every provider: `provider` (`codex`, `claude`, or `copilot`), a nonempty provider-owned `model`, optional `effort` (`low`, `medium`, or `high`), and optional `execution`. Effort defaults to `medium`. Execution requests describe approval, sandbox, and network policy; Sigil validates them against the selected adapter and reports requested and effective behavior separately.

`sigil setup` resolves the Git root and adds exact `build`, `test`, and `verify` package scripts only when it can identify one package manager from the manifest or lockfiles. It reports these commands without running them. Implementation workflows require at least one configured build or test eval; planning-only and configuration-independent custom Sigils do not.

Comparable values use this precedence: command option, project file, schema default. `sigil config show --effective` retains field provenance rather than inferring it from a defaulted object. Each projected field contains `value`, `source` (`command`, `project`, `user`, or `default`), and, when safe, `location`, `redacted`, and capability `support` (`supported`, `unsupported`, or `unknown`).

```sh
sigil config show --effective --repo /path/to/repo --json
sigil discover-env --repo /path/to/repo --json
```

The effective-configuration JSON record has `version`, `kind`, `configPath`, `fields`, `routingPolicy`, and `capabilities`. It is deterministic and does not probe accounts. `profile status` is the separate current-eligibility record. A resolved assignment is emitted only when an agent is reserved. None predicts a future assignment.

Redaction is allowlist-based. Output excludes credentials and credential-source names, provider profile directories, account identity, raw environment data, prompts, transcripts, and private local paths. Profile names are visible metadata, so do not put identities or secrets in them.
