import { basename } from "node:path";

import type { ConfigSource, ResolvedConfig } from "./config.js";
import {
  providerCapabilities,
  providerTransports,
  type CapabilitySupport,
  type ProviderTransport,
} from "./provider-capabilities.js";

export const EFFECTIVE_CONFIG_VERSION = 1;

export type SafeConfigLocation = { file: string };
export type AttributedValue = {
  value: unknown;
  source: ConfigSource;
  location?: SafeConfigLocation;
  redacted: false;
};
export type RedactedValue = {
  value: null;
  source: ConfigSource | "user";
  redacted: true;
};
export type EffectiveCapability = {
  transport: ProviderTransport;
  approval: CapabilitySupport;
  sandbox: CapabilitySupport;
  network: CapabilitySupport;
};
export type EffectiveConfig = {
  version: typeof EFFECTIVE_CONFIG_VERSION;
  kind: "effective-config";
  configFile: SafeConfigLocation;
  values: Record<string, AttributedValue | RedactedValue>;
  capabilities: EffectiveCapability[];
  routing: {
    assignment: "resolved-at-agent-creation";
    policy: "one-shot-then-subscription-then-explicit-metered";
    candidateProfiles: readonly string[];
  };
};

export type EffectiveConfigOptions = { candidateProfiles?: readonly string[] };

export function projectEffectiveConfig(
  resolved: ResolvedConfig,
  options: EffectiveConfigOptions = {},
): EffectiveConfig {
  const location = { file: basename(resolved.configPath) };
  const values: Record<string, AttributedValue> = {};
  visitLeaves(resolved.config, [], (path, value) => {
    const key = path.join(".");
    const source = resolved.provenance[key] ?? "default";
    values[key] = {
      value,
      source,
      ...(source === "project" ? { location } : {}),
      redacted: false,
    };
  });

  return {
    version: EFFECTIVE_CONFIG_VERSION,
    kind: "effective-config",
    configFile: location,
    values,
    capabilities: configuredCapabilities(resolved),
    routing: {
      assignment: "resolved-at-agent-creation",
      policy: "one-shot-then-subscription-then-explicit-metered",
      candidateProfiles: [...(options.candidateProfiles ?? [])].sort(),
    },
  };
}

export function renderEffectiveConfig(config: EffectiveConfig): string {
  const lines = [
    `Effective configuration (${config.configFile.file})`,
    ...Object.entries(config.values).map(([path, attributed]) =>
      `${path} = ${JSON.stringify(attributed.value)} [${attributed.source}]`),
    "Assignment: resolved at agent creation; no assignment predicted.",
  ];
  return lines.join("\n");
}

function configuredCapabilities(resolved: ResolvedConfig): EffectiveCapability[] {
  const transports = new Set<ProviderTransport>();
  for (const binding of Object.values(resolved.config.agents)) {
    for (const transport of providerTransports(binding.provider)) transports.add(transport);
  }
  return [...transports].sort().map((transport) => {
    const capability = providerCapabilities(transport);
    return {
      transport,
      approval: capability.approval,
      sandbox: capability.sandbox,
      network: capability.network,
    };
  });
}

function visitLeaves(
  value: unknown,
  path: string[],
  visit: (path: string[], value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitLeaves(entry, [...path, String(index)], visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) visitLeaves(entry, [...path, key], visit);
    return;
  }
  visit(path, value);
}
