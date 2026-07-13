import { z } from "zod";

export const PROFILE_PROVIDERS = ["codex", "claude"] as const;
export type ProfileProvider = typeof PROFILE_PROVIDERS[number];
export type QualifiedProfileIdentity = `${ProfileProvider}:${string}`;
export type ProfileAccessClass = "subscription" | "metered-api";
export type MeteredMode = "manual" | "overflow" | "automatic";
export type ReservationLiveness = "live" | "dead" | "unverifiable";

export class ProfileStoreError extends Error {
  constructor(
    public readonly code: "corrupt" | "unsupported-version" | "unsafe-permissions" | "lock-unverifiable" | "credential-unresolved",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileStoreError";
  }
}

export type ProfileReference = {
  provider: ProfileProvider;
  name: string;
  qualifiedIdentity: QualifiedProfileIdentity;
};

export function qualifiedProfileIdentity<P extends ProfileProvider>(
  provider: P,
  name: string,
): `${P}:${string}` {
  return `${provider}:${name}`;
}

export function resolveProfileSelector<T extends { provider: ProfileProvider; name: string }>(
  selector: string,
  profiles: readonly T[],
): T {
  const qualified = selector.includes(":");
  const matches = profiles.filter((profile) => qualified
    ? qualifiedProfileIdentity(profile.provider, profile.name) === selector
    : profile.name === selector);
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`profile not found: ${selector}`);
  throw new Error(`ambiguous profile selector: ${selector}`);
}

export const ProcessOwnerSchema = z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
}).strict();

export const ReservationSchema = z.object({
  id: z.string().min(1),
  profile: z.string().min(1),
  owner: ProcessOwnerSchema,
  startedAt: z.string().datetime(),
  unresolved: z.literal(true),
}).passthrough();

export type SafeProfileDto = ProfileReference & {
  version: 1;
  accessClass: ProfileAccessClass;
  enabled: boolean;
  mode?: MeteredMode;
  admissionLimit?: { unit: "starts" | "tokens" | "milliseconds" | "usd"; value: number };
  operationLimit?: { unit: "tokens" | "usd"; value: number };
};
