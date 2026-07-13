import { approveAll, CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { spawnSync } from "node:child_process";
import type { AgentBinding } from "../config.js";
import { createTextAgentFromGenerate, type AgentOptions, type AgentPromptOptions, type AgentRuntimeMetadata, type SigilAgent, type TextGenerate } from "../agent.js";

type CopilotSessionLike = Pick<CopilotSession, "sendAndWait" | "abort" | "disconnect" | "on">;
type CopilotClientLike = { createSession(config: SessionConfig): Promise<CopilotSessionLike>; stop(): Promise<Error[]> };
type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

export function copilotCliAvailable(): boolean { return spawnSync("copilot", ["--version"], { stdio: "ignore" }).status === 0; }
export function copilotSdkAvailable(): boolean { return true; }

export function createCopilotAgent(binding: AgentBinding, cwd: string, runtime?: AgentRuntimeMetadata): SigilAgent {
  const client = new CopilotClient({ workingDirectory: cwd });
  const agent = createCopilotAgentFromClient(client, binding, cwd);
  if (runtime) Object.defineProperty(agent, "runtime", { value: runtime });
  return agent;
}
export function createCopilotAgentFromClient(client: CopilotClientLike, binding: AgentBinding, cwd: string): SigilAgent {
  let session: Promise<CopilotSessionLike> | undefined;

  const getSession = () => {
    session ??= client.createSession({
      model: binding.model,
      reasoningEffort: reasoningEffort(agentEffort(binding)),
      workingDirectory: cwd,
      onPermissionRequest: approveAll,
    });
    return session;
  };

  return createCopilotAgentFromGenerate(
    async (text, options) => {
      const active = await getSession();
      const unsubscribe = active.on((event) => {
        if (event.type === "assistant.message_delta") options?.onProgress?.("text");
        else options?.onProgress?.("provider");
      });
      const abort = () => void active.abort();
      options?.signal?.addEventListener("abort", abort, { once: true });

      try {
        options?.signal?.throwIfAborted();
        const response = await active.sendAndWait({ prompt: text });
        return response?.data.content ?? "";
      } finally {
        options?.signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
    async () => {
      if (session) await (await session).disconnect();
      await client.stop();
    },
  );
}

export function createCopilotAgentFromGenerate(generate: TextGenerate, close: () => void | Promise<void> = () => {}): SigilAgent {
  return createTextAgentFromGenerate(generate, close);
}


function agentEffort(binding: AgentBinding): string { return binding.effort ?? "medium"; }
function reasoningEffort(value: string | undefined): CopilotReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}
