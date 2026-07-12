import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export type AgentProvider = "claude" | "codex" | "copilot";
export type AgentBinding = { provider: AgentProvider; model: string; effort?: string };
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

export const AgentBindingSchema = z.object({
  provider: z.enum(["claude", "codex", "copilot"]),
  model: z.string().min(1),
  effort: z.string().min(1).default("medium"),
});
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
  const path = findConfigPath(rootDir);
  if (!path) throw new Error(`Missing ${join(resolve(rootDir), CONFIG_FILE)}`);

  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  validateAgentReferences(parsed.data, path);
  return parsed.data;
}

export function resolveAgentBinding(name: string, config = loadConfig()): AgentBinding {
  const binding = config.agents[name];
  if (!binding) throw new Error(`Unknown agent "${name}" in ${CONFIG_FILE}`);
  return binding;
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
