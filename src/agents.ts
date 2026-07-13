import type { AgentBinding } from "./config.js";
import { loadConfig, parseAgentBinding, resolveAgentBinding } from "./config.js";
import {
  LazySigilAgent,
  isSchemaPromptError,
  promptTextWithSchema,
  type AgentOptions,
  type SigilAgent,
} from "./agent.js";
import { createProviderAgent } from "./providers/index.js";

export type {
  AgentOptions,
  AgentProgressKind,
  AgentPromptOptions,
  AgentRuntimeMetadata,
  SigilAgent,
} from "./agent.js";
export { isSchemaPromptError, promptTextWithSchema } from "./agent.js";

export function agent(name: string, opts?: AgentOptions): SigilAgent;
export function agent(binding: AgentBinding, opts?: AgentOptions): SigilAgent;
export function agent(nameOrBinding: string | AgentBinding, opts: AgentOptions = {}): SigilAgent {
  const cwd = opts.cwd ?? process.cwd();
  const binding = typeof nameOrBinding === "string"
    ? resolveAgentBinding(nameOrBinding, loadConfig(cwd))
    : parseAgentBinding(nameOrBinding);
  const runtime = {
    binding: `${binding.provider}:${binding.model}`,
    provider: binding.provider,
    effort: binding.effort ?? "medium",
  } as const;
  return new LazySigilAgent(() => createProviderAgent(binding, cwd, opts, runtime), runtime);
}

export async function withAgent<T>(binding: string | AgentBinding, fn: (agent: SigilAgent) => Promise<T>, opts?: AgentOptions): Promise<T> {
  const active = typeof binding === "string" ? agent(binding, opts) : agent(binding, opts);
  try { return await fn(active); }
  finally { await active.close(); }
}
