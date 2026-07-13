export type HelpFlag = { name: string; description: string };
export type CommandHelp = {
  name: string;
  summary: string;
  usage: string;
  flags: HelpFlag[];
  exitCode: string;
};

export const commandHelps = [
  {
    name: "dashboard",
    summary: "Serve a read-only live dashboard for local Sigil runs.",
    usage: "sigil dashboard [--host 127.0.0.1] [--port <number>] [--root <dir>]...",
    flags: [
      { name: "--host <loopback>", description: "Loopback host. Defaults to 127.0.0.1; remote binding is rejected." },
      { name: "--port <number>", description: "Local HTTP port. Defaults to 4317; use 0 to select an available port." },
      { name: "--root <dir>", description: "Optional repeatable additional run-discovery root; the current directory is included automatically." },
    ],
    exitCode: "0 after an orderly local shutdown; 1 when startup fails.",
  },
  {
    name: "config",
    summary: "Inspect deterministic effective project configuration and its provenance.",
    usage: "sigil config show --effective [--repo <dir>] [--json]",
    flags: [
      { name: "show --effective", description: "Resolve defaults, project input, and command overlays without probing providers." },
      { name: "--repo <dir>", description: "Repository directory. Defaults to the current directory." },
      { name: "--json", description: "Print the stable machine-readable effective-configuration record." },
    ],
    exitCode: "0 when effective configuration is printed; 1 for invalid or missing configuration; 2 for invalid usage.",
  },
  {
    name: "profile",
    summary: "Manage local provider profiles and inspect routing eligibility.",
    usage: "sigil profile <add|remove|list|inspect|status|next|enable|disable|prime|rearm> ...",
    flags: [
      { name: "add <name> --provider <codex|claude> --class <subscription|metered-api>", description: "Register a provider-owned authentication context and bounded routing policy." },
      { name: "--home <dir> | --default-config | --config-dir <dir> | --credential-source <name>", description: "Select provider-owned authentication without displaying its location or credential source." },
      { name: "--concurrency <count>", description: "Limit simultaneous assignments for the profile." },
      { name: "--token-limit <count>", description: "Set the metered admission token budget." },
      { name: "--start-limit <count>", description: "Set the metered agent-start budget." },
      { name: "--runtime-limit-ms <count>", description: "Set the cumulative metered runtime budget." },
      { name: "--reservation-tokens <count>", description: "Reserve this maximum token charge for each admitted metered agent." },
      { name: "--quantum <percentage>", description: "Reserve this headroom for each admitted subscription agent." },
      { name: "--reserve-floor <percentage>", description: "Keep subscription admission above this inclusive 0-100 capacity floor." },
      { name: "--capacity-poll-ms <milliseconds>", description: "Set the bounded live-capacity polling cadence for an active subscription assignment." },
      { name: "--mode <manual|overflow|automatic>", description: "Explicitly authorize when a metered profile may be assigned; overflow is used only after subscriptions are ineligible." },
      { name: "--require-rearm", description: "Require explicit rearm after metered completion or active subscription capacity exhaustion." },
      { name: "--admission-usd <amount> --operation-usd <amount>", description: "Bound Claude API admission and each admitted operation." },
      { name: "--json", description: "Print a versioned, machine-readable record instead of the safe human summary." },
      { name: "list [--provider <provider>]", description: "List safe registry summaries without reading live provider state." },
      { name: "inspect <provider:name|unique-name>", description: "Show one profile policy and its stored routing state." },
      { name: "next <provider:name|unique-name> --agents <count>", description: "Route a bounded number of new agents without bypassing eligibility policy." },
      { name: "prime <provider:name|unique-name> [--repo <dir>]", description: "Explicitly start a Codex subscription window; Claude returns unsupported." },
      { name: "rearm <name>", description: "Clear authentication, capacity, transient, and metered rearm blocks without changing active reservations or usage accounting." },
      { name: "status [--provider <provider>]", description: "Show current eligibility and safe provider evidence separately from registry inspection." },
    ],
    exitCode: "0 when the requested local profile operation succeeds; 1 otherwise.",
  },
  {
    name: "task-graph",
    summary: "Validate an assistant-authored task graph or print its public schema.",
    usage: "sigil task-graph validate [--repo <dir>] [--json] <task-file> | sigil task-graph schema [--out <file>]",
    flags: [
      { name: "validate <task-file>", description: "Validate one task graph's structure, dependencies, cycles, and repository paths." },
      { name: "--repo <dir>", description: "Repository directory used to resolve and check task file paths." },
      { name: "--json", description: "Print the stable machine-readable validation record." },
      { name: "schema", description: "Print the public task-graph JSON Schema." },
      { name: "--out <file>", description: "Write the schema to a file instead of standard output." },
    ],
    exitCode: "0 when validation succeeds or the schema is written; 1 when validation fails; 2 for invalid usage.",
  },
  {
    name: "migrate",
    summary: "Apply a dependency-ordered repository migration with verified commit checkpoints.",
    usage: "sigil migrate --repo <dir> --target <file> --backlog <file> --run-dir <dir>",
    flags: [
      { name: "--repo <dir>", description: "Required. Clean named branch to migrate." },
      { name: "--target <file>", description: "Required. Target architecture and invariants." },
      { name: "--backlog <file>", description: "Required. Dependency-ordered migration backlog JSON." },
      { name: "--run-dir <dir>", description: "Required. Durable external checkpoint, event, and review directory; temporary storage is rejected." },
    ],
    exitCode: "0 when every item, final review, build, and test passes; 1 otherwise.",
  },
  {
    name: "refactor",
    summary: "Apply a behavior-preserving structural change with analysis, gates, and independent review.",
    usage: "sigil refactor --repo <dir> --intent <text> [--brief <file>] [--focus <path>]... [--protected-path <path>]...",
    flags: [
      { name: "--repo <dir>", description: "Required. Clean target repository to refactor in place." },
      { name: "--intent <text>", description: "Required. Structural change to make while preserving behavior." },
      { name: "--brief <file>", description: "Optional file with refactor constraints and invariants." },
      { name: "--focus <path>", description: "Optional repeatable starting path; additional relevant paths remain available." },
      { name: "--protected-path <path>", description: "Optional repeatable path the refactor must not modify." },
    ],
    exitCode: "0 when final build and test gates pass without recorded issues; 1 otherwise.",
  },
  {
    name: "probe",
    summary: "Run sandboxed probes, synthesize findings, and produce a task graph.",
    usage: "sigil probe --repo <dir> --intent <text> [--brief <file>] [--out <file>] [--max-probes <n>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository to investigate without modifying." },
      { name: "--intent <text>", description: "Required. Product or workflow improvement intent to probe." },
      { name: "--brief <file>", description: "Optional file with extra non-authoritative probe context." },
      { name: "--out <file>", description: "Optional task graph output path." },
      { name: "--max-probes <n>", description: "Optional maximum number of generated probe commands to run." },
    ],
    exitCode: "0 when the produced task graph is valid and the target working tree is preserved; 1 otherwise.",
  },
  {
    name: "plan",
    summary: "Turn an intent and optional brief into a task graph.",
    usage: "sigil plan --repo <dir> --intent <text> [--brief <file>] [--out <file>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--intent <text>", description: "Required. Change intent to plan." },
      { name: "--brief <file>", description: "Optional file with extra planning context." },
      { name: "--out <file>", description: "Optional task graph output path." },
    ],
    exitCode: "0 when the produced task graph is valid; 1 otherwise.",
  },
  {
    name: "software-change",
    summary: "Plan, implement, verify, review, and report one local change without publishing.",
    usage: "sigil software-change --repo <dir> --intent <text> [--brief <file>] [--out <file>] [--task-file <file>] [--branch <name>] [--instructions <file>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--intent <text>", description: "Required. Change intent to plan and implement." },
      { name: "--brief <file>", description: "Optional file with extra planning context." },
      { name: "--out <file>", description: "Optional task graph output path." },
      { name: "--task-file <file>", description: "Optional existing typed task graph file to implement without planning." },
      { name: "--branch <name>", description: "Optional implementation branch name." },
      { name: "--instructions <file>", description: "Optional run-specific implementation instructions." },
    ],
    exitCode: "0 when the workflow result is valid and reports no issues; 1 otherwise.",
  },
  {
    name: "implement",
    summary: "Apply a task graph, commit verified tasks, run gates, and review locally.",
    usage: "sigil implement --repo <dir> --task-file <file> [--branch <name>] [--instructions <file>] [--publish]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--task-file <file>", description: "Required. Task graph JSON file." },
      { name: "--branch <name>", description: "Optional branch name." },
      { name: "--instructions <file>", description: "Optional run-specific implementation instructions." },
      { name: "--publish", description: "After local success, push the branch and open a pull request." },
    ],
    exitCode: "0 when review is not blocking and no failed tasks or issues are reported; with --publish, pull-request creation must also succeed.",
  },
  {
    name: "review",
    summary: "Review the current diff against a base ref.",
    usage: "sigil review --repo <dir> --base <ref> [--no-autofix] [--context <text>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--base <ref>", description: "Required. Base ref for the diff." },
      { name: "--no-autofix", description: "Disable the autofix pass." },
      { name: "--context <text>", description: "Optional review context." },
    ],
    exitCode: "0 when there are no unresolved high findings and no reported issues; 1 otherwise.",
  },
  {
    name: "breakdown",
    summary: "Turn a mission into an ordered backlog file.",
    usage: "sigil breakdown --repo <dir> --mission <text> [--out <file>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--mission <text>", description: "Required. Mission text." },
      { name: "--out <file>", description: "Optional backlog output path." },
    ],
    exitCode: "0 when the produced backlog is valid; 1 otherwise.",
  },
  {
    name: "dispatch",
    summary: "Call software-change for backlog items, then merge and verify by policy.",
    usage: "sigil dispatch --repo <dir> --backlog <file> --policy mergeWhenGreen|integrationBranch --run-dir <dir> [...] | sigil dispatch --resume <dir>",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--backlog <file>", description: "Required. Backlog JSON file." },
      { name: "--policy mergeWhenGreen|integrationBranch", description: "Required delivery policy." },
      { name: "--integration-branch <branch>", description: "Required with integrationBranch. Accumulating branch for item changes." },
      { name: "--final-action openPullRequest|mergeWhenGreen", description: "Integration delivery action after all items pass. Defaults to openPullRequest." },
      { name: "--production-gate <name>", description: "Configured gate run after a successful final merge." },
      { name: "--run-dir <dir>", description: "Required durable dispatch manifest, operation, and recovery directory." },
      { name: "--resume <dir>", description: "Resume the recorded operation after validating repository state and live process ownership." },
    ],
    exitCode: "0 when dispatch finishes; 1 when it stops on a deterministic failure; 75 when durable capacity waiting is retryable.",
  },
  {
    name: "validate-workflow",
    summary: "Validate a static YAML workflow file.",
    usage: "sigil validate-workflow [--repo <dir>] <workflow-file>",
    flags: [
      { name: "--repo <dir>", description: "Repository directory used to resolve config-backed agents. Defaults to the current directory." },
      { name: "<workflow-file>", description: "Required. YAML workflow file." },
    ],
    exitCode: "0 when the workflow error array is empty; 1 otherwise.",
  },
  {
    name: "validate-sigil",
    summary: "Validate a TypeScript sigil file without running it.",
    usage: "sigil validate-sigil <workflow.ts>",
    flags: [
      { name: "<workflow.ts>", description: "Required. TypeScript sigil file exporting default or named workflow." },
    ],
    exitCode: "0 when the sigil imports and has a callable export; 1 otherwise.",
  },
  {
    name: "run-workflow",
    summary: "Run a static YAML workflow file against a target repository.",
    usage: "sigil run-workflow --repo <dir> --file <workflow-file>",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--file <workflow-file>", description: "Required. YAML workflow file." },
    ],
    exitCode: "0 when the workflow completes without recorded issues; 1 otherwise.",
  },
  {
    name: "run-sigil",
    summary: "Launch a detached TypeScript sigil run against a target repository.",
    usage: "sigil run-sigil --repo <dir> --file <workflow.ts> [--input <input.json>] [--out <result.json>] [--run-dir <dir>] [--persistence durable|ephemeral]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--file <workflow.ts>", description: "Required. TypeScript sigil file exporting default or named workflow." },
      { name: "--input <input.json>", description: "Optional JSON object merged into the workflow input; --repo wins over any repo field in the file." },
      { name: "--out <result.json>", description: "Optional final result path written by the detached worker." },
      { name: "--run-dir <dir>", description: "Optional run directory for the manifest, PID, status, events, log, artifacts, result, and error; durable runs default to <repo>/.sigil/runs/." },
      { name: "--persistence durable|ephemeral", description: "Storage policy. Durable is the default and rejects temporary repositories, inputs, outputs, and run directories." },
    ],
    exitCode: "0 when the detached worker launches; 1 when launch validation fails.",
  },
  {
    name: "setup",
    summary: "Write the default sigil.config.json and ignore local run state.",
    usage: "sigil setup [--dir <repo>] [--force]",
    flags: [
      { name: "--dir <repo>", description: "Repository directory. Defaults to the current directory." },
      { name: "--force", description: "Overwrite an existing config file." },
    ],
    exitCode: "0 when the config is written; 1 when it already exists without --force.",
  },
  {
    name: "discover-env",
    summary: "Report prerequisites for each configured role and candidate transport without probing authentication.",
    usage: "sigil discover-env [--repo <dir>] [--json]",
    flags: [
      { name: "--repo <dir>", description: "Repository directory. Defaults to the current directory." },
      { name: "--json", description: "Print the versioned prerequisite report as JSON." },
    ],
    exitCode: "0 when the environment report is printed; 1 when config cannot be loaded.",
  },
] as const satisfies readonly CommandHelp[];

export type CommandName = typeof commandHelps[number]["name"];

export function commandNames(): CommandName[] {
  return commandHelps.map((help) => help.name);
}

export function findCommandHelp(name: string): CommandHelp | undefined {
  return commandHelps.find((help) => help.name === name);
}

export function isCommandName(name: string): name is CommandName {
  return findCommandHelp(name) !== undefined;
}

export function renderGlobalHelp(): string {
  return [
    "Usage:",
    ...commandHelps.map((help) => `  ${help.usage}`),
    "",
    "Run 'sigil <command> --help' for command-specific help.",
  ].join("\n");
}

export function renderCommandHelp(name: CommandName): string {
  const help = findCommandHelp(name);
  if (!help) throw new Error(`unknown command: ${name}`);
  return [
    `Usage: ${help.usage}`,
    "",
    help.summary,
    "",
    "Arguments and flags:",
    ...help.flags.map((flag) => `  ${flag.name}\n      ${flag.description}`),
    "",
    `Exit codes: ${help.exitCode}`,
  ].join("\n");
}
