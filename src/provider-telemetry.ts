import { z } from "zod";
import type { AgentProvider } from "./config.js";

export const PROVIDER_TELEMETRY_VERSION = 1;

export const JsonSafeValueSchema: z.ZodType<JsonSafeValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonSafeValueSchema), z.record(z.string(), JsonSafeValueSchema),
]));
export type JsonSafeValue = string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue };
export type ObservationDetails = Record<string, JsonSafeValue>;

export const ObservationEnvelopeSchema = z.object({
  version: z.literal(PROVIDER_TELEMETRY_VERSION),
  at: z.string(),
  stage: z.string(),
  details: z.record(z.string(), JsonSafeValueSchema),
}).strict();
export type ObservationEnvelope = z.infer<typeof ObservationEnvelopeSchema>;

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
};

export type ResolvedProviderAssignment = {
  provider: AgentProvider;
  profile: string;
  accessClass: "subscription" | "metered-api";
  transport: "codex-acp" | "claude-cli-pty" | "claude-agent-sdk" | "copilot-sdk";
  model: string;
  effort: string;
  routingReason: string;
  effectiveExecution: ObservationDetails;
};

export function terminalObservationSummary(details: ObservationDetails): string {
  return Object.values(details)
    .filter((value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(String)
    .join(" ");
}
