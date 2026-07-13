import { ClaudeSDKAgent } from "@mastra/claude";

import type { AgentBinding } from "./config.js";
import type { ClaudeProfile } from "./claude-profiles.js";
import { resolveExecutionPolicy } from "./provider-capabilities.js";
import { ProviderError } from "./provider-failure.js";

export type ClaudeObservedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type ClaudeSdkResult<T = unknown> = {
  text: string;
  object?: T;
  usage?: ClaudeObservedUsage;
};

export type ClaudeSdkGenerate = <T>(
  text: string,
  options?: Record<string, unknown>,
) => Promise<ClaudeSdkResult<T>>;

export function createClaudeSdkGenerate(
  binding: AgentBinding,
  cwd: string,
  profile: ClaudeProfile,
  credential: string,
): ClaudeSdkGenerate {
  if (profile.accessClass !== "metered-api" || !("credentialSource" in profile.details)) {
    throw new ProviderError("Claude SDK requires a metered profile", { code: "profile_unavailable" });
  }
  const limit = profile.operation?.usdLimit;
  if (!limit) throw new ProviderError("Claude SDK requires a hard operation budget", { code: "budget_exhausted" });
  const execution = resolveExecutionPolicy("claude-agent-sdk", binding.execution);
  const agent = new ClaudeSDKAgent({
    id: "sigil-claude-agent",
    name: "sigil-claude-agent",
    description: "Sigil Claude SDK agent",
    sdkOptions: {
      cwd,
      model: binding.model,
      effort: binding.effort ?? "medium",
      permissionMode: execution.adapter.args[0] as "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: limit,
      env: sdkEnvironment(profile.details.credentialSource, credential),
    },
  });

  return async <T>(text: string, options?: Record<string, unknown>) => {
    const result = await agent.generate<T>(text, options);
    return { text: result.text, object: result.object, usage: observedUsage(result) };
  };
}

export function sdkEnvironment(source: string, credential: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  environment[source] = credential;
  return environment;
}

export function observedUsage(result: unknown): ClaudeObservedUsage | undefined {
  const value = result as Record<string, any>;
  const usage = value.totalUsage ?? value.usage;
  const cost = value.providerMetadata?.claude?.costContext?.totalCostUsd
    ?? value.providerMetadata?.costContext?.totalCostUsd
    ?? value.costContext?.totalCostUsd;
  if (!usage && typeof cost !== "number") return undefined;
  const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    costUsd: typeof cost === "number" ? cost : 0,
  };
}
