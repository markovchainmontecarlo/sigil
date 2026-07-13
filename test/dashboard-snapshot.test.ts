import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createDashboardSnapshot } from "../src/dashboard/snapshot.js";

describe("dashboard snapshots", () => {
  test("current view groups attempts and omits stale history", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-current-"));
    writeRun(root, "old-failure", "project", "workflow.ts", "failed", "2026-01-01T00:00:00.000Z");
    writeRun(root, "new-success", "project", "workflow.ts", "succeeded", "2026-01-02T00:00:00.000Z");
    writeRun(root, "stale", "other", "other.ts", "running", "2026-01-03T00:00:00.000Z", 999_999);

    const current = await createDashboardSnapshot([root]);
    const history = await createDashboardSnapshot([root], "history");

    expect(current.discoveredRunCount).toBe(3);
    expect(current.runs).toHaveLength(1);
    expect(current.runs[0]).toMatchObject({ project: "project", category: "recent", attemptCount: 2 });
    expect(history.runs).toHaveLength(3);
  });

  test("current view treats legacy custom dispatch runs as dispatch attempts", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-dispatch-"));
    writeRun(
      root,
      "legacy-failure",
      "project",
      "workflow.ts",
      "failed",
      "2026-01-01T00:00:00.000Z",
      undefined,
      "dispatch/renderer-release-packaging",
    );
    writeRun(root, "active-dispatch", "project", "dispatch", "running", "2026-01-02T00:00:00.000Z", process.pid);

    const current = await createDashboardSnapshot([root]);

    expect(current.runs).toHaveLength(1);
    expect(current.runs[0]).toMatchObject({ workflow: "dispatch", category: "active", attemptCount: 2 });
  });
});

function writeRun(
  root: string,
  name: string,
  project: string,
  workflow: string,
  state: string,
  updatedAt: string,
  pid?: number,
  operationPath?: string,
): void {
  const run = join(root, name);
  mkdirSync(run);
  writeFileSync(join(run, "manifest.json"), JSON.stringify({ repo: `/repos/${project}`, file: `/workflows/${workflow}` }));
  writeFileSync(join(run, "status.json"), JSON.stringify({ state, updatedAt, pid }));
  writeFileSync(
    join(run, "events.jsonl"),
    `${JSON.stringify({ at: updatedAt, stage: state, ...(operationPath ? { operationPath } : {}) })}\n`,
  );
}
