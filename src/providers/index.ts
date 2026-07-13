import type { AgentBinding } from "../config.js";
import type { AgentOptions, AgentRuntimeMetadata, SigilAgent } from "../agent.js";
import { ProviderError } from "../provider-failure.js";

export async function createProviderAgent(binding: AgentBinding, cwd: string, options: AgentOptions, runtime: AgentRuntimeMetadata): Promise<SigilAgent> {
  try {
    if (binding.provider === "codex") return (await import("./codex.js")).createCodexAgent(binding, cwd, options, runtime);
    if (binding.provider === "claude") return (await import("./claude.js")).createClaudeAgent(binding, cwd, options, runtime);
    if (binding.provider === "copilot") return (await import("./copilot.js")).createCopilotAgent(binding, cwd, runtime);
    throw new ProviderError(`Unsupported agent provider ${String(binding.provider)}`, { code: "invalid_request" });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Provider adapter initialization failed: ${message}`, { code: "invalid_request", cause: error });
  }
}
