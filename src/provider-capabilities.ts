import {
  AGENT_EFFORTS,
  AGENT_PROVIDERS,
  type AgentEffort,
  type AgentProvider,
  type ExecutionPolicy,
} from "./agent-binding.js";

export { AGENT_EFFORTS, AGENT_PROVIDERS } from "./agent-binding.js";
export type { AgentEffort, AgentProvider, ExecutionPolicy } from "./agent-binding.js";

export type ApprovalPolicy = "unattended";
export type SandboxPolicy = "workspace-write" | "unrestricted";
export type NetworkPolicy = "enabled" | "disabled";
export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type RequestedExecutionPolicy = Required<ExecutionPolicy>;
export type EffectiveExecutionPolicy = {
  approval: ApprovalPolicy;
  sandbox: SandboxPolicy;
  network: NetworkPolicy;
};
export type ProviderTransport =
  | "codex-acp"
  | "claude-cli-pty"
  | "claude-agent-sdk"
  | "copilot-cli"
  | "copilot-sdk";
export type ProviderCapabilities = {
  provider: AgentProvider;
  transport: ProviderTransport;
  efforts: readonly AgentEffort[];
  priming: CapabilitySupport;
  approval: CapabilitySupport;
  sandbox: CapabilitySupport;
  network: CapabilitySupport;
};
export type ExecutionResolution = {
  requested: RequestedExecutionPolicy;
  effective: EffectiveExecutionPolicy;
  support: { approval: CapabilitySupport; sandbox: CapabilitySupport; network: CapabilitySupport };
  adapter: { args: readonly string[]; copilotApproveAll: boolean };
};

const DEFAULT_EXECUTION: RequestedExecutionPolicy = {
  approval: "unattended",
  sandbox: "unrestricted",
  network: "enabled",
};

const CAPABILITIES: Record<ProviderTransport, ProviderCapabilities> = {
  "codex-acp": { provider: "codex", transport: "codex-acp", efforts: AGENT_EFFORTS, priming: "supported", approval: "supported", sandbox: "supported", network: "supported" },
  "claude-cli-pty": { provider: "claude", transport: "claude-cli-pty", efforts: AGENT_EFFORTS, priming: "unsupported", approval: "supported", sandbox: "unsupported", network: "unsupported" },
  "claude-agent-sdk": { provider: "claude", transport: "claude-agent-sdk", efforts: AGENT_EFFORTS, priming: "unsupported", approval: "supported", sandbox: "unsupported", network: "unsupported" },
  "copilot-cli": { provider: "copilot", transport: "copilot-cli", efforts: AGENT_EFFORTS, priming: "unsupported", approval: "supported", sandbox: "unsupported", network: "unsupported" },
  "copilot-sdk": { provider: "copilot", transport: "copilot-sdk", efforts: AGENT_EFFORTS, priming: "unsupported", approval: "supported", sandbox: "unsupported", network: "unsupported" },
};

export function providerCapabilities(transport: ProviderTransport): ProviderCapabilities {
  return CAPABILITIES[transport];
}

export function providerTransports(provider: AgentProvider): readonly ProviderTransport[] {
  return Object.values(CAPABILITIES)
    .filter((capabilities) => capabilities.provider === provider)
    .map((capabilities) => capabilities.transport);
}

export function resolveExecutionPolicy(
  transport: ProviderTransport,
  request: ExecutionPolicy = {},
): ExecutionResolution {
  const requested = { ...DEFAULT_EXECUTION, ...request };
  const capabilities = providerCapabilities(transport);
  if (requested.sandbox === "workspace-write" && capabilities.sandbox !== "supported") {
    throw new Error(`${transport} does not support requested sandbox workspace-write`);
  }
  if (requested.network === "disabled" && capabilities.network !== "supported") {
    throw new Error(`${transport} does not support requested network disabled`);
  }

  if (transport === "codex-acp") return codexExecution(requested, capabilities);
  if (transport === "claude-cli-pty") return claudeCliExecution(requested, capabilities);
  return unrestrictedExecution(transport, requested, capabilities);
}

function codexExecution(requested: RequestedExecutionPolicy, capabilities: ProviderCapabilities): ExecutionResolution {
  const sandbox = requested.sandbox === "unrestricted" ? "workspace-write" : requested.sandbox;
  return resolution(requested, { ...requested, sandbox }, capabilities, [
    "approval_policy=never",
    `sandbox_mode=${sandbox}`,
    `sandbox_workspace_write.network_access=${requested.network === "enabled"}`,
  ]);
}

function claudeCliExecution(requested: RequestedExecutionPolicy, capabilities: ProviderCapabilities): ExecutionResolution {
  return resolution(requested, { ...requested, sandbox: "unrestricted", network: "enabled" }, capabilities, [
    "--dangerously-skip-permissions",
  ]);
}

function unrestrictedExecution(
  transport: ProviderTransport,
  requested: RequestedExecutionPolicy,
  capabilities: ProviderCapabilities,
): ExecutionResolution {
  const args = transport === "claude-agent-sdk" ? ["bypassPermissions"] : [];
  return resolution(requested, { ...requested, sandbox: "unrestricted", network: "enabled" }, capabilities, args);
}

function resolution(
  requested: RequestedExecutionPolicy,
  effective: EffectiveExecutionPolicy,
  capabilities: ProviderCapabilities,
  args: readonly string[],
): ExecutionResolution {
  return {
    requested,
    effective,
    support: { approval: capabilities.approval, sandbox: capabilities.sandbox, network: capabilities.network },
    adapter: { args, copilotApproveAll: capabilities.provider === "copilot" },
  };
}
