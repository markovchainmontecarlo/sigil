import { z } from "zod";

import type { AgentProvider } from "./agent-binding.js";
import type { CodexCapacityTelemetry, CapacityReader } from "./codex-router.js";
import type { CodexProfileStore, CodexUsage } from "./codex-profiles.js";
import type { ClaudeProfileStore } from "./claude-profiles.js";
import type { ClaudeObservedUsage } from "./claude-sdk.js";
import type { ClaudePtyDependencies } from "./claude-pty.js";
import type { ProcessLifecycle } from "./owned-process.js";
import { retryPromptLoop } from "./gate.js";

export interface SigilAgent {
  prompt(text: string): Promise<string>;
  prompt<T>(text: string, schema: z.ZodType<T>): Promise<T>;
  promptWithOptions?<T>(text: string, schema: z.ZodType<T> | undefined, options: AgentPromptOptions): Promise<string | T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
  readonly runtime?: AgentRuntimeMetadata;
}

export type AgentProgressKind = "text" | "tool" | "provider";
export type AgentPromptOptions = { signal?: AbortSignal; onProgress?: (kind: AgentProgressKind) => void };
export type AgentRuntimeMetadata = {
  binding?: string;
  effort?: "low" | "medium";
  profile?: string;
  providerSessionId?: string;
  childProcessId?: number;
  childStartIdentity?: string;
  provider?: AgentProvider;
  accessClass?: "subscription" | "metered-api";
  transport?: "codex-acp" | "claude-cli-pty" | "claude-agent-sdk" | "copilot-sdk";
  routingReason?: string;
  usage?: CodexUsage | ClaudeObservedUsage;
  active?: boolean;
};
export type AgentOptions = {
  cwd?: string;
  capacityReader?: CapacityReader;
  profileStore?: CodexProfileStore;
  claudeProfileStore?: ClaudeProfileStore;
  claudePtyDependencies?: Partial<ClaudePtyDependencies>;
  resumeSessionId?: string;
  onRuntimeUpdate?: (runtime: AgentRuntimeMetadata) => void | Promise<void>;
  processLifecycle?: ProcessLifecycle;
  onCapacityTelemetry?: (telemetry: CodexCapacityTelemetry) => void | Promise<void>;
  onProviderEvent?: (event: { type: string; details: Record<string, string | number | boolean> }) => void | Promise<void>;
};

export const SCHEMA_PROMPT_RETRY_ATTEMPTS = 2;
export class SchemaPromptError extends Error {
  constructor(readonly issue: string) { super(`schema prompt failed: ${issue}`); this.name = "SchemaPromptError"; }
}
export function isSchemaPromptError(error: unknown): error is SchemaPromptError { return error instanceof SchemaPromptError; }
export type TextGenerate = (text: string, options?: AgentPromptOptions) => Promise<string>;

export class LazySigilAgent implements SigilAgent {
  private initialized?: Promise<SigilAgent>;
  private closed = false;
  constructor(private readonly initialize: () => Promise<SigilAgent>, readonly runtime: AgentRuntimeMetadata = {}) {}
  private active(): Promise<SigilAgent> {
    if (this.closed) return Promise.reject(new Error("agent is closed"));
    return this.initialized ??= this.initialize();
  }
  async prompt<T>(text: string, schema?: z.ZodType<T>): Promise<string | T> {
    const agent = await this.active();
    return schema ? agent.prompt(text, schema) : agent.prompt(text);
  }
  async promptWithOptions<T>(text: string, schema: z.ZodType<T> | undefined, options: AgentPromptOptions): Promise<string | T> {
    const agent = await this.active();
    return agent.promptWithOptions?.(text, schema, options) ?? (schema ? agent.prompt(text, schema) : agent.prompt(text));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.initialized) await (await this.initialized).close();
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export function createTextAgentFromGenerate(generate: TextGenerate, close: () => void | Promise<void> = () => {}, runtime: AgentRuntimeMetadata = {}): SigilAgent {
  return {
    prompt<T>(text: string, schemaOrOptions?: z.ZodType<T> | AgentPromptOptions, options?: AgentPromptOptions): Promise<string | T> {
      const schema = schemaOrOptions instanceof z.ZodType ? schemaOrOptions : undefined;
      const promptOptions = schema ? options : schemaOrOptions as AgentPromptOptions | undefined;
      return schema ? promptTextWithSchema(generate, text, schema, SCHEMA_PROMPT_RETRY_ATTEMPTS, promptOptions) : generate(text, promptOptions);
    },
    promptWithOptions<T>(text: string, schema: z.ZodType<T> | undefined, options: AgentPromptOptions) {
      return schema ? promptTextWithSchema(generate, text, schema, SCHEMA_PROMPT_RETRY_ATTEMPTS, options) : generate(text, options);
    },
    async close() { await close(); },
    async [Symbol.asyncDispose]() { await this.close(); },
    runtime,
  };
}

export async function promptTextWithSchema<T>(generate: TextGenerate, text: string, schema: z.ZodType<T>, attempts = SCHEMA_PROMPT_RETRY_ATTEMPTS, options?: AgentPromptOptions): Promise<T> {
  let reply = "";
  const result = await retryPromptLoop<{ ok: true; value: T }>({
    initialPrompt: `${text}\n\nReply with valid JSON only. Do not wrap the JSON in markdown.`,
    attempts,
    runTurn: async (turnPrompt) => { reply = await generate(turnPrompt, options); },
    validate: async () => validateJsonReply(reply, schema),
    correctionPrompt: (issue, original) => `Your previous turn failed its schema gate: ${issue}. You MUST reply with valid JSON only matching the requested schema. Original instruction follows.\n\n${original}`,
    defaultIssue: "schema gate failed",
  });
  if (result.ok) return result.value;
  throw new SchemaPromptError(result.issue);
}

function validateJsonReply<T>(reply: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; issue: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(reply); }
  catch (error) { return { ok: false, issue: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, issue: `schema invalid: ${formatZodIssues(checked.error)}` };
  return { ok: true, value: checked.data };
}
export function formatZodIssues(error: z.ZodError): string { return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "); }
