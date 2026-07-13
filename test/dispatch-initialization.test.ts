import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { DEFAULT_SIGIL_CONFIG } from "../src/config.js";
import { createContext } from "../src/context.js";
import { DispatchProfileReconciliationError, initializeDispatchProfiles } from "../src/workflows/dispatch/initialization.js";
import type { ReservationReconciliation } from "../src/codex-router.js";

const context = () => createContext(mkdtempSync(join(tmpdir(), "sigil-dispatch-initialization-")));

describe("dispatch initialization", () => {
  test("records safe provider-neutral reconciliation without starting a provider", async () => {
    const ctx = context();
    let reconciliations = 0;
    const result: ReservationReconciliation = {
      outcomes: [{ profile: "codex:pro", outcome: "settled" }],
      blocked: false,
    };

    await initializeDispatchProfiles(ctx, DEFAULT_SIGIL_CONFIG, {
      reconcileReservations: async () => {
        reconciliations++;
        return result;
      },
    });

    const artifact = JSON.parse(readFileSync(ctx.artifacts.path("dispatch-initialization/profile-reconciliation.json"), "utf8"));
    expect(reconciliations).toBe(1);
    expect(artifact).toEqual(result);
    expect(JSON.stringify(artifact)).not.toContain("home");
    expect(JSON.stringify(artifact)).not.toContain("prime");
  });

  test.each(["retained-live", "retained-unverifiable"] as const)("blocks %s ownership", async (outcome) => {
    const ctx = context();
    await expect(initializeDispatchProfiles(ctx, DEFAULT_SIGIL_CONFIG, {
      reconcileReservations: async () => ({
        outcomes: [{ profile: "claude:pro", outcome }],
        blocked: true,
      }),
    })).rejects.toBeInstanceOf(DispatchProfileReconciliationError);
    const artifact = JSON.parse(readFileSync(ctx.artifacts.path("dispatch-initialization/profile-reconciliation.json"), "utf8"));
    expect(artifact.outcomes).toEqual([{ profile: "claude:pro", outcome }]);
  });

  test("reuses completed reconciliation on resume", async () => {
    const ctx = context();
    let reconciliations = 0;
    const reconcileReservations = async (): Promise<ReservationReconciliation> => {
      reconciliations++;
      return { outcomes: [], blocked: false };
    };

    await initializeDispatchProfiles(ctx, DEFAULT_SIGIL_CONFIG, { reconcileReservations });
    const artifactPath = ctx.artifacts.path("dispatch-initialization/profile-reconciliation.json");
    const first = readFileSync(artifactPath, "utf8");
    await initializeDispatchProfiles(ctx, DEFAULT_SIGIL_CONFIG, { reconcileReservations });

    expect(reconciliations).toBe(1);
    expect(readFileSync(artifactPath, "utf8")).toBe(first);
  });
});
