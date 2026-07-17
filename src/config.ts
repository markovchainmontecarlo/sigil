import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  AgentBindingSchema,
  parseAgentBinding,
  type AgentBinding,
  type AgentEffort,
  type AgentProvider,
  type ExecutionPolicy,
} from "./agent-binding.js";

export {
  AgentBindingSchema,
  parseAgentBinding,
  type AgentBinding,
  type AgentEffort,
  type AgentProvider,
  type ExecutionPolicy,
} from "./agent-binding.js";
export type ContextEntry = { path: string; update: boolean };
export type EvalDefinition = string | { command: string; covers: string[] };
export type SigilConfig = {
  agents: Record<string, AgentBinding>;
  evals: Record<string, EvalDefinition>;
  workspace: { bootstrap?: string; ready?: string };
  context: ContextEntry[];
  plan: {
    planners: string[];
    synthesizer: string;
  };
  implement: {
    coder: string;
    sessionTaskLimit: number;
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
  evals?: Record<string, EvalDefinition>;
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
    "sol-medium": { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
    "terra-medium": { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
    "luna-medium": { provider: "codex", model: "gpt-5.6-luna", effort: "medium" },
  },
  evals: {},
  workspace: {},
  context: [],
  plan: {
    planners: ["sol-medium", "terra-medium", "luna-medium"],
    synthesizer: "sol-medium",
  },
  implement: {
    coder: "sol-medium",
    sessionTaskLimit: 5,
    repairLimit: 3,
    operationTimeoutMs: 5_400_000,
    idleTimeoutMs: 300_000,
    cancellationGraceMs: 5_000,
    branchPrefix: "sigil/",
    baseBranch: "main",
  },
  review: { reviewers: ["sol-medium", "terra-medium", "luna-medium"], synthesizer: "sol-medium", followUpReviews: 0 },
};

const ContextEntrySchema = z.object({
  path: z.string().min(1),
  update: z.boolean().default(false),
});

const EvalDefinitionSchema = z.union([
  z.string().min(1),
  z.object({
    command: z.string().min(1),
    covers: z.array(z.string().min(1)).default([]),
  }).strict(),
]);

const ConfigSchema: z.ZodType<SigilConfig> = z.object({
  agents: z.record(z.string(), AgentBindingSchema),
  evals: z.record(z.string(), EvalDefinitionSchema),
  workspace: z.object({
    bootstrap: z.string().min(1).optional(),
    ready: z.string().min(1).optional(),
  }).default({}),
  context: z.array(ContextEntrySchema).default([]),
  plan: z.object({
    planners: z.array(z.string().min(1)),
    synthesizer: z.string().min(1),
  }),
  implement: z.object({
    coder: z.string().min(1),
    sessionTaskLimit: z.number().int().positive(),
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
  if (!path) {
    const root = resolve(rootDir);
    throw new Error([
      `Missing ${join(root, CONFIG_FILE)}`,
      `Run: sigil setup --dir ${root}`,
    ].join("\n"));
  }

  const rawProject = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(rawProject)) throw new Error(`Invalid ${path}: configuration must be an object`);
  const merged = mergeProjectConfig(DEFAULT_SIGIL_CONFIG, rawProject);
  const configured = mergeValue(merged, commandOverlay);
  const parsed = ConfigSchema.safeParse(configured);
  if (!parsed.success) throw new Error(`Invalid ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  validateAgentReferences(parsed.data, path);
  validateEvalReferences(parsed.data, path);
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
  const definition = config.evals[name];
  return typeof definition === "string" ? definition : definition?.command;
}

export function resolveEvalPlan(names: readonly string[], config = loadConfig()): string[] {
  const requested = new Set(names);
  const covered = new Set<string>();
  for (const name of names) collectCoveredEvals(name, config, covered);
  return names.filter((name) => !covered.has(name) || !requested.has(name));
}

function collectCoveredEvals(name: string, config: SigilConfig, covered: Set<string>): void {
  const definition = config.evals[name];
  if (typeof definition === "string" || !definition) return;
  for (const dependency of definition.covers) {
    if (covered.has(dependency)) continue;
    covered.add(dependency);
    collectCoveredEvals(dependency, config, covered);
  }
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
  if (Object.prototype.hasOwnProperty.call(project, "plan")) merged.plan = project.plan;
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

function validateEvalReferences(config: SigilConfig, path: string): void {
  const errors: string[] = [];
  for (const [name, definition] of Object.entries(config.evals)) {
    if (typeof definition === "string") continue;
    for (const covered of definition.covers) {
      if (covered === name) errors.push(`evals.${name}.covers cannot include itself`);
      else if (!(covered in config.evals)) errors.push(`evals.${name}.covers references unknown eval "${covered}"`);
    }
  }
  const complete = new Set<string>();
  const active = new Set<string>();
  const visit = (name: string): void => {
    if (complete.has(name)) return;
    if (active.has(name)) {
      errors.push(`eval coverage cycle includes "${name}"`);
      return;
    }
    active.add(name);
    const definition = config.evals[name];
    if (typeof definition !== "string") {
      for (const covered of definition?.covers ?? []) visit(covered);
    }
    active.delete(name);
    complete.add(name);
  };
  for (const name of Object.keys(config.evals)) visit(name);
  if (errors.length) throw new Error(`Invalid ${path}: ${errors.join("; ")}`);
}
