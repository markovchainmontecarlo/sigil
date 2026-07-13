import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { SigilConfig } from "../../config.js";
import type { SigilContext } from "../../context.js";
import { resolveUnfinishedReservations, type ReservationReconciliation } from "../../codex-router.js";

export type DispatchInitializationOptions = {
  reconcileReservations?: () => Promise<ReservationReconciliation>;
};

export class DispatchProfileReconciliationError extends Error {
  readonly code = "provider-reservation-blocked";

  constructor() {
    super("dispatch cannot start while a provider reservation has live or unverifiable ownership");
    this.name = "DispatchProfileReconciliationError";
  }
}

export async function initializeDispatchProfiles(
  ctx: SigilContext,
  _config: SigilConfig,
  options: DispatchInitializationOptions = {},
): Promise<void> {
  const artifact = "dispatch-initialization/profile-reconciliation.json";
  const artifactPath = ctx.artifacts.path(artifact);
  const reconciliation = existsSync(artifactPath)
    ? JSON.parse(await readFile(artifactPath, "utf8")) as ReservationReconciliation
    : await (options.reconcileReservations ?? resolveUnfinishedReservations)();

  if (!existsSync(artifactPath)) {
    await ctx.artifacts.write(artifact, `${JSON.stringify(reconciliation, null, 2)}\n`);
  }

  if (reconciliation.blocked) throw new DispatchProfileReconciliationError();
}
