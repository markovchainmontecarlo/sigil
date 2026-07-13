import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

import { codexAcpAvailable, copilotCliAvailable, copilotSdkAvailable } from "../agents.js";
import { claudePtyAvailable } from "../claude-pty.js";
import { readClaudeProfiles, type ClaudeProfile } from "../claude-profiles.js";
import { readCodexProfiles, type CodexProfile } from "../codex-profiles.js";
import { loadConfig, type SigilConfig } from "../config.js";
import { AGENT_PROVIDERS } from "../provider-capabilities.js";
import { printJson } from "./output.js";
import { parseCommandArgs, rejectPositionals, value } from "./parse.js";

export const ENVIRONMENT_REPORT_VERSION = 1;

type PrerequisiteKind = "executable" | "adapter-package" | "configuration-directory" | "credential-source";
type Prerequisite = { kind: PrerequisiteKind; available: boolean };
type CandidateTransport = { transport: string; accessClass?: "subscription" | "metered-api"; prerequisites: Prerequisite[] };
type RoleEnvironment = { role: string; provider: string; candidates: CandidateTransport[] };
export type EnvironmentReport = { version: typeof ENVIRONMENT_REPORT_VERSION; kind: "environment-prerequisites"; roles: RoleEnvironment[] };

export type PrerequisiteReaders = {
  codexAdapter: () => boolean;
  claudeCli: () => boolean;
  claudeSdk: () => boolean;
  copilotCli: () => boolean;
  copilotSdk: () => boolean;
  directory: (path: string) => boolean;
  credentialSource: (name: string) => boolean;
};

const systemReaders: PrerequisiteReaders = {
  codexAdapter: codexAcpAvailable,
  claudeCli: claudePtyAvailable,
  claudeSdk: () => true,
  copilotCli: copilotCliAvailable,
  copilotSdk: copilotSdkAvailable,
  directory: readableDirectory,
  credentialSource: (name) => Boolean(process.env[name]),
};
const [CODEX, CLAUDE] = AGENT_PROVIDERS;

export async function inspectEnvironment(
  config: SigilConfig,
  readers: PrerequisiteReaders = systemReaders,
  profiles?: { codex: CodexProfile[]; claude: ClaudeProfile[] },
): Promise<EnvironmentReport> {
  const availableProfiles = profiles ?? {
    codex: await readCodexProfiles(),
    claude: await readClaudeProfiles(),
  };
  const roles = Object.entries(config.agents).map(([role, binding]) => ({
    role,
    provider: binding.provider,
    candidates: candidatesFor(binding.provider, availableProfiles, readers),
  }));
  return { version: ENVIRONMENT_REPORT_VERSION, kind: "environment-prerequisites", roles };
}

export async function discoverEnvCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, { repo: { type: "string" }, json: { type: "boolean" } });
  rejectPositionals(parsed);

  const repo = resolve(value(parsed, "repo") ?? process.cwd());
  try {
    const report = await inspectEnvironment(loadConfig(repo));
    if (parsed.values.json === true) printJson(report);
    else console.log(renderEnvironment(report));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function candidatesFor(
  provider: string,
  profiles: { codex: CodexProfile[]; claude: ClaudeProfile[] },
  readers: PrerequisiteReaders,
): CandidateTransport[] {
  if (provider === CODEX) return profiles.codex.map((profile) => ({
    transport: "codex-acp",
    accessClass: profile.profileClass,
    prerequisites: [
      { kind: "adapter-package", available: readers.codexAdapter() },
      { kind: "configuration-directory", available: readers.directory(profile.home) },
    ],
  }));
  if (provider === CLAUDE) return profiles.claude.map((profile) => claudeCandidate(profile, readers));
  return [
    { transport: "copilot-cli", prerequisites: [{ kind: "executable", available: readers.copilotCli() }] },
    { transport: "copilot-sdk", prerequisites: [{ kind: "adapter-package", available: readers.copilotSdk() }] },
  ];
}

function claudeCandidate(profile: ClaudeProfile, readers: PrerequisiteReaders): CandidateTransport {
  if ("defaultConfiguration" in profile.details) return {
    transport: "claude-cli-pty",
    accessClass: profile.accessClass,
    prerequisites: [{ kind: "executable", available: readers.claudeCli() }],
  };
  if ("configurationDirectory" in profile.details) return {
    transport: "claude-cli-pty",
    accessClass: profile.accessClass,
    prerequisites: [
      { kind: "executable", available: readers.claudeCli() },
      { kind: "configuration-directory", available: readers.directory(profile.details.configurationDirectory) },
    ],
  };
  return {
    transport: "claude-agent-sdk",
    accessClass: profile.accessClass,
    prerequisites: [
      { kind: "adapter-package", available: readers.claudeSdk() },
      { kind: "credential-source", available: readers.credentialSource(profile.details.credentialSource) },
    ],
  };
}

function renderEnvironment(report: EnvironmentReport): string {
  const lines = [`Environment prerequisites (schema ${report.version})`];
  for (const role of report.roles) {
    lines.push(`${role.role} (${role.provider})`);
    if (!role.candidates.length) lines.push("  no configured candidate transports");
    for (const candidate of role.candidates) {
      lines.push(`  ${candidate.transport}${candidate.accessClass ? ` (${candidate.accessClass})` : ""}`);
      for (const prerequisite of candidate.prerequisites) lines.push(`    ${prerequisite.kind}: ${prerequisite.available ? "available" : "missing"}`);
    }
  }
  lines.push("Availability is a prerequisite check only; authentication and capacity are not verified.");
  return lines.join("\n");
}

function readableDirectory(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
