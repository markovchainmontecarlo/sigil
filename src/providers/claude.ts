import type { AgentBinding } from "../config.js";
import type { AgentOptions, AgentRuntimeMetadata, SigilAgent } from "../agent.js";

export async function createClaudeAgent(binding: AgentBinding, cwd: string, options: AgentOptions, runtime: AgentRuntimeMetadata): Promise<SigilAgent> {
  const { createRoutedClaudeAgent } = await import("../claude-router.js");
  return createRoutedClaudeAgent(binding, cwd, options, runtime);
}

export { createClaudeAgentFromGenerate } from "../claude-router.js";
