import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startDashboardServer, type DashboardServer } from "../src/dashboard/server.js";
import type { DashboardSnapshot } from "../src/dashboard/types.js";

let dashboard: DashboardServer | undefined;

afterEach(() => {
  dashboard?.stop();
  dashboard = undefined;
});

describe("dashboard server", () => {
  test("serves the shell, health check, and normalized snapshot on loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-http-"));
    const run = join(root, "run");
    mkdirSync(run);
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ repo: "/repo/example", file: "/workflow.ts" }));
    writeFileSync(join(run, "status.json"), JSON.stringify({ state: "succeeded", updatedAt: new Date().toISOString() }));
    writeFileSync(join(run, "events.jsonl"), "");
    dashboard = startDashboardServer({ host: "127.0.0.1", port: 0, roots: [root], refreshMs: 25 });

    const health = await fetch(`${dashboard.url}/healthz`);
    const shell = await fetch(dashboard.url);
    const snapshot = await fetch(`${dashboard.url}/api/snapshot`).then((response) => response.json()) as DashboardSnapshot;

    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");
    expect(await shell.text()).toContain("Sigil runs");
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].project).toBe("example");
    expect(snapshot.discoveredRunCount).toBe(1);
    expect(snapshot.view).toBe("current");
    expect(JSON.stringify(snapshot)).not.toContain("auth.json");
  });

  test("rejects mutations and unknown paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-method-"));
    dashboard = startDashboardServer({ host: "127.0.0.1", port: 0, roots: [root] });

    expect((await fetch(`${dashboard.url}/api/snapshot`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${dashboard.url}/private-file`)).status).toBe(404);
  });

  test("archives runs from the current view without removing their history", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-archive-"));
    const run = join(root, "run");
    const archiveFile = join(root, "dashboard", "archives.json");
    mkdirSync(run);
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ repo: "/repo/example", file: "/workflow.ts" }));
    writeFileSync(join(run, "status.json"), JSON.stringify({ state: "succeeded", updatedAt: new Date().toISOString() }));
    writeFileSync(join(run, "events.jsonl"), "");
    dashboard = startDashboardServer({ host: "127.0.0.1", port: 0, roots: [root], archiveFile });
    const initial = await fetch(`${dashboard.url}/api/snapshot`).then((response) => response.json()) as DashboardSnapshot;

    const archive = await fetch(`${dashboard.url}/api/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: initial.runs[0].id, archived: true }),
    });
    const current = await fetch(`${dashboard.url}/api/snapshot`).then((response) => response.json()) as DashboardSnapshot;
    const history = await fetch(`${dashboard.url}/api/history`).then((response) => response.json()) as DashboardSnapshot;

    expect(archive.status).toBe(200);
    expect(current.runs).toHaveLength(0);
    expect(history.runs[0]).toMatchObject({ id: initial.runs[0].id, archived: true });
  });

  test("refuses to archive an active run", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-active-archive-"));
    const run = join(root, "run");
    mkdirSync(run);
    writeFileSync(join(run, "status.json"), JSON.stringify({ state: "running", pid: process.pid }));
    writeFileSync(join(run, "events.jsonl"), "");
    dashboard = startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      roots: [root],
      archiveFile: join(root, "dashboard", "archives.json"),
    });
    const snapshot = await fetch(`${dashboard.url}/api/snapshot`).then((response) => response.json()) as DashboardSnapshot;

    const archive = await fetch(`${dashboard.url}/api/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: snapshot.runs[0].id, archived: true }),
    });

    expect(archive.status).toBe(409);
    expect(await archive.text()).toBe("Active runs cannot be archived");
  });
});
