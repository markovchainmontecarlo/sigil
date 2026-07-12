import { primeCodexProfile } from "../../agents.js";
import {
  CODEX_PROVIDER,
  resolveAgentBinding,
  type SigilConfig,
} from "../../config.js";
import type { SigilContext } from "../../context.js";
import {
  readCodexProfiles,
  type CodexProfile,
} from "../../codex-profiles.js";
import { resolveUnfinishedReservations } from "../../codex-router.js";

type PrimeResult = {
  profile: string;
  outcome: "active" | "primed" | "failed";
  error?: string;
};

export type DispatchInitializationOptions = {
  readProfiles?: () => Promise<CodexProfile[]>;
  resolveReservations?: () => Promise<void>;
  primeProfile?: typeof primeCodexProfile;
};

export async function initializeDispatchProfiles(
  ctx: SigilContext,
  config: SigilConfig,
  options: DispatchInitializationOptions = {},
): Promise<void> {
  const resolveReservations = options.resolveReservations ?? resolveUnfinishedReservations;
  const readProfiles = options.readProfiles ?? readCodexProfiles;
  const primeProfile = options.primeProfile ?? primeCodexProfile;

  await resolveReservations();

  const binding = resolveAgentBinding(config.implement.coder, config);
  const profiles = (await readProfiles())
    .filter((profile) => profile.enabled && profile.profileClass === "subscription");
  const results = binding.provider === CODEX_PROVIDER
    ? await Promise.all(profiles.map((profile) => prime(
        profile,
        binding,
        primeProfile,
        ctx.processLifecycle,
      )))
    : [];

  await ctx.artifacts.write(
    "dispatch-initialization/codex-profile-priming.json",
    `${JSON.stringify({ results }, null, 2)}\n`,
  );
}

async function prime(
  profile: CodexProfile,
  binding: ReturnType<typeof resolveAgentBinding>,
  primeProfile: typeof primeCodexProfile,
  processLifecycle: SigilContext["processLifecycle"],
): Promise<PrimeResult> {
  try {
    const result = await primeProfile(profile, binding, processLifecycle);
    return {
      profile: profile.name,
      outcome: result.windowStarted ? "primed" : "active",
    };
  } catch (error) {
    return {
      profile: profile.name,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
