import { z } from "zod";

export const AGENT_PROVIDERS = ["codex", "claude", "copilot"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

export const AGENT_EFFORTS = ["low", "medium"] as const;
export type AgentEffort = typeof AGENT_EFFORTS[number];

export type ExecutionPolicy = {
  approval?: "unattended";
  sandbox?: "workspace-write" | "unrestricted";
  network?: "enabled" | "disabled";
};

export type AgentBinding = {
  provider: AgentProvider;
  model: string;
  effort?: AgentEffort;
  execution?: ExecutionPolicy;
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
  if (binding.provider === "codex") return;
  const transport = binding.provider === "claude" ? "claude-cli-pty" : "copilot-cli";
  if (binding.execution?.sandbox === "workspace-write") {
    context.addIssue({
      code: "custom",
      path: ["execution", "sandbox"],
      message: `${transport} does not support requested sandbox workspace-write`,
    });
  }
  if (binding.execution?.network === "disabled") {
    context.addIssue({
      code: "custom",
      path: ["execution", "network"],
      message: `${transport} does not support requested network disabled`,
    });
  }
});

export function parseAgentBinding(input: unknown): AgentBinding {
  return AgentBindingSchema.parse(input);
}
