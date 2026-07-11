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
    summary: "Apply a task graph, run gates and review, then push and open a PR.",
    usage: "sigil implement --repo <dir> --task-file <file> [--branch <name>] [--instructions <file>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--task-file <file>", description: "Required. Task graph JSON file." },
      { name: "--branch <name>", description: "Optional branch name." },
      { name: "--instructions <file>", description: "Optional run-specific implementation instructions." },
    ],
    exitCode: "0 when PR creation succeeds, review is not blocking, and no failed tasks or issues are reported; 1 otherwise.",
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
    usage: "sigil dispatch --repo <dir> --backlog <file> --policy mergeWhenGreen|integrationBranch [--integration-branch <branch>] [--final-action openPullRequest|mergeWhenGreen] [--production-gate <name>]",
    flags: [
      { name: "--repo <dir>", description: "Required. Target repository." },
      { name: "--backlog <file>", description: "Required. Backlog JSON file." },
      { name: "--policy mergeWhenGreen|integrationBranch", description: "Required delivery policy." },
      { name: "--integration-branch <branch>", description: "Required with integrationBranch. Accumulating branch for item changes." },
      { name: "--final-action openPullRequest|mergeWhenGreen", description: "Integration delivery action after all items pass. Defaults to openPullRequest." },
      { name: "--production-gate <name>", description: "Configured gate run after a successful final merge." },
    ],
    exitCode: "0 when dispatch finishes without stopping; 1 when it stops at a backlog item.",
  },
  {
    name: "validate",
    summary: "Validate a task graph file.",
    usage: "sigil validate [--repo <dir>] <task-file>",
    flags: [
      { name: "--repo <dir>", description: "Repository directory used to resolve and check task file paths." },
      { name: "<task-file>", description: "Required. Task graph JSON file." },
    ],
    exitCode: "0 when the validation error array is empty; 1 otherwise.",
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
    summary: "Print a read-only report of configured agents, Codex native ACP reachability, and Claude auth source.",
    usage: "sigil discover-env [--repo <dir>]",
    flags: [
      { name: "--repo <dir>", description: "Repository directory. Defaults to the current directory." },
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
