import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AGENT_EFFORTS, AGENT_PROVIDERS, resolveExecutionPolicy, type AgentEffort, type AgentProvider, type ExecutionPolicy } from "./provider-capabilities.js";

export type { AgentEffort, AgentProvider, ExecutionPolicy } from "./provider-capabilities.js";
export type AgentBinding = { provider: AgentProvider; model: string; effort?: AgentEffort; execution?: ExecutionPolicy };
export type ContextEntry = { path: string; update: boolean };
export type SigilConfig = {
  agents: Record<string, AgentBinding>;
  evals: Record<string, string>;
  workspace: { bootstrap?: string; ready?: string };
  context: ContextEntry[];
  plan: { planners: string[]; synthesizer: string };
  implement: {
    coder: string;
    batchSize: number;
    repairLimit: number;
    operationTimeoutMs: number;
    idleTimeoutMs: number;
    cancellationGraceMs: number;
    branchPrefix: string;
    baseBranch: string;
    testReport?: { path: string; format: "junit" };
  };
  review: { reviewers: string[]; synthesizer: string; followUpReviews: number };
};
export type ConfigSource = "command" | "project" | "default";
export type ConfigOverlay = {
  agents?: Record<string, Partial<AgentBinding>>;
  evals?: Record<string, string>;
  workspace?: Partial<SigilConfig["workspace"]>;
  context?: ContextEntry[];
  plan?: Partial<SigilConfig["plan"]>;
  implement?: Partial<SigilConfig["implement"]>;
  review?: Partial<SigilConfig["review"]>;
};
export type ResolvedConfig = {
  config: SigilConfig;
  configPath: string;
  rawProject: Readonly<Record<string, unknown>>;
  commandOverlay: Readonly<ConfigOverlay>;
  provenance: Readonly<Record<string, ConfigSource>>;
};

export const CONFIG_FILE = "sigil.config.json";
export const CODEX_EXECUTABLE = "codex";
export const CODEX_PROVIDER: AgentProvider = "codex";

export const DEFAULT_SIGIL_CONFIG: SigilConfig = {
  agents: {
    "sol-low": { provider: "codex", model: "gpt-5.6-sol", effort: "low" },
    "terra-low": { provider: "codex", model: "gpt-5.6-terra", effort: "low" },
    "luna-low": { provider: "codex", model: "gpt-5.6-luna", effort: "low" },
    "sol-medium": { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
  },
  evals: {},
  workspace: {},
  context: [],
  plan: { planners: ["sol-low", "terra-low", "luna-low"], synthesizer: "sol-low" },
  implement: {
    coder: "sol-low",
    batchSize: 5,
    repairLimit: 3,
    operationTimeoutMs: 5_400_000,
    idleTimeoutMs: 300_000,
    cancellationGraceMs: 5_000,
    branchPrefix: "sigil/",
    baseBranch: "main",
  },
  review: { reviewers: ["sol-low", "terra-low", "luna-low"], synthesizer: "sol-low", followUpReviews: 0 },
};

const ExecutionPolicySchema = z.object({
  approval: z.literal("unattended").optional(),
  sandbox: z.enum(["workspace-write", "unrestricted"]).optional(),
  network: z.enum(["enabled", "disabled"]).optional(),
}).optional();

export const AgentBindingSchema = z.object({
  provider: z.enum(AGENT_PROVIDERS, { error: (issue) => issue.input === "claude-pty"
    ? 'provider "claude-pty" was replaced by provider "claude" with local profile selection'
    : "unsupported provider" }),
  model: z.string().trim().min(1),
  effort: z.enum(AGENT_EFFORTS).default("medium"),
  execution: ExecutionPolicySchema,
}).superRefine((binding, context) => {
  const transports = binding.provider === "claude"
    ? ["claude-cli-pty", "claude-agent-sdk"] as const
    : binding.provider === "codex" ? ["codex-acp"] as const : ["copilot-cli", "copilot-sdk"] as const;
  for (const transport of transports) {
    try { resolveExecutionPolicy(transport, binding.execution); }
    catch (error) { context.addIssue({ code: "custom", path: ["execution"], message: String(error instanceof Error ? error.message : error) }); }
  }
});

export function parseAgentBinding(input: unknown): AgentBinding {
  return AgentBindingSchema.parse(input);
}
const ContextEntrySchema = z.object({
  path: z.string().min(1),
  update: z.boolean().default(false),
});

const ConfigSchema: z.ZodType<SigilConfig> = z.object({
  agents: z.record(z.string(), AgentBindingSchema),
  evals: z.record(z.string(), z.string().min(1)),
  workspace: z.object({
    bootstrap: z.string().min(1).optional(),
    ready: z.string().min(1).optional(),
  }).default({}),
  context: z.array(ContextEntrySchema).default([]),
  plan: z.object({ planners: z.array(z.string().min(1)), synthesizer: z.string().min(1) }),
  implement: z.object({
    coder: z.string().min(1),
    batchSize: z.number().finite(),
    repairLimit: z.number().finite(),
    operationTimeoutMs: z.number().int().positive().default(5_400_000),
    idleTimeoutMs: z.number().int().positive().default(300_000),
    cancellationGraceMs: z.number().int().positive().default(5_000),
    branchPrefix: z.string().min(1),
    baseBranch: z.string().min(1),
    testReport: z.object({ path: z.string().min(1), format: z.literal("junit") }).optional(),
  }),
  review: z.object({
    reviewers: z.array(z.string().min(1)).min(1),
    synthesizer: z.string().min(1),
    followUpReviews: z.number().int().nonnegative().default(0),
  }),
});

export function loadConfig(rootDir = process.cwd()): SigilConfig {
  return resolveConfig(rootDir).config;
}

export function resolveConfig(rootDir = process.cwd(), commandOverlay: ConfigOverlay = {}): ResolvedConfig {
  const path = findConfigPath(rootDir);
  if (!path) throw new Error(`Missing ${join(resolve(rootDir), CONFIG_FILE)}`);

  const rawProject = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(rawProject)) throw new Error(`Invalid ${path}: configuration must be an object`);
  const merged = mergeProjectConfig(DEFAULT_SIGIL_CONFIG, rawProject);
  const configured = mergeValue(merged, commandOverlay);
  const parsed = ConfigSchema.safeParse(configured);
  if (!parsed.success) throw new Error(`Invalid ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  validateAgentReferences(parsed.data, path);
  return {
    config: parsed.data,
    configPath: path,
    rawProject,
    commandOverlay,
    provenance: collectProvenance(parsed.data, rawProject, commandOverlay),
  };
}

export function resolveAgentBinding(name: string, config = loadConfig()): AgentBinding {
  const binding = config.agents[name];
  if (!binding) throw new Error(`Unknown agent "${name}" in ${CONFIG_FILE}`);
  return parseAgentBinding(binding);
}

export function resolveEvalCommand(name: string, config = loadConfig()): string | undefined {
  return config.evals[name];
}

function findConfigPath(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) return path;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(...values: unknown[]): unknown {
  return values.reduce<unknown>((result, value) => mergeValue(result, value), {});
}

function mergeProjectConfig(defaults: SigilConfig, project: Record<string, unknown>): unknown {
  const merged = mergeConfig(defaults, project) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(project, "agents")) merged.agents = project.agents;
  if (Object.prototype.hasOwnProperty.call(project, "evals")) merged.evals = project.evals;
  return merged;
}

function mergeValue(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = key in merged ? mergeValue(merged[key], value) : value;
  }
  return merged;
}

function collectProvenance(
  config: SigilConfig,
  project: Record<string, unknown>,
  command: ConfigOverlay,
): Record<string, ConfigSource> {
  const provenance: Record<string, ConfigSource> = {};
  visitLeaves(config, [], (path) => {
    provenance[path.join(".")] = hasPath(command, path)
      ? "command"
      : hasPath(project, path) ? "project" : "default";
  });
  return provenance;
}

function visitLeaves(value: unknown, path: string[], visit: (path: string[]) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitLeaves(entry, [...path, String(index)], visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) visitLeaves(entry, [...path, key], visit);
    return;
  }
  visit(path);
}

function hasPath(value: unknown, path: string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || !(index in current)) return false;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function validateAgentReferences(config: SigilConfig, path: string): void {
  const refs = [
    ...config.plan.planners.map((name, i) => [`plan.planners[${i}]`, name] as const),
    ["plan.synthesizer", config.plan.synthesizer] as const,
    ["implement.coder", config.implement.coder] as const,
    ...config.review.reviewers.map((name, i) => [`review.reviewers[${i}]`, name] as const),
    ["review.synthesizer", config.review.synthesizer] as const,
  ];
  const errors = refs
    .filter(([, name]) => !config.agents[name])
    .map(([field, name]) => `${field} references unknown agent "${name}"`);
  if (errors.length) throw new Error(`Invalid ${path}: ${errors.join("; ")}`);
}
