import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readCodexProfiles, readCodexRoutingState } from "../codex-profiles.js";
import { circuitIsOpen } from "../codex-router.js";
import { discoverRunDirectories } from "./discovery.js";
import { readRun } from "./read-run.js";
import type { DashboardSnapshot, ProfileSummary, RunSummary } from "./types.js";

export async function createDashboardSnapshot(
  roots: string[],
  view: "current" | "history" = "current",
): Promise<DashboardSnapshot> {
  const directories = await discoverRunDirectories(roots);
  const selected = view === "current" ? await recentDirectories(directories, 100) : directories;
  return await snapshotFromDirectories(selected, directories.length, view);
}

export function createDashboardSnapshotReader(
  roots: string[],
  rediscoveryMs = 30_000,
): (view?: "current" | "history") => Promise<DashboardSnapshot> {
  let currentDirectories: string[] = [];
  let discoveredRunCount = 0;
  let rediscoverAfter = 0;

  return async (view = "current") => {
    if (view === "history") return await createDashboardSnapshot(roots, view);
    if (Date.now() >= rediscoverAfter) {
      const directories = await discoverRunDirectories(roots);
      currentDirectories = await recentDirectories(directories, 100);
      discoveredRunCount = directories.length;
      rediscoverAfter = Date.now() + rediscoveryMs;
    }
    return await snapshotFromDirectories(currentDirectories, discoveredRunCount, view);
  };
}

async function snapshotFromDirectories(
  directories: string[],
  discoveredRunCount: number,
  view: "current" | "history",
): Promise<DashboardSnapshot> {
  const runs = await Promise.all(directories.map(readSafeRun));
  const normalized = runs.filter((run): run is RunSummary => run !== undefined);

  return {
    generatedAt: new Date().toISOString(),
    runs: view === "current" ? currentRuns(normalized) : normalized.sort(compareRuns),
    profiles: await profileSummaries(),
    discoveredRunCount,
    view,
  };
}

async function recentDirectories(directories: string[], limit: number): Promise<string[]> {
  const ranked = await Promise.all(directories.map(async (dir) => ({
    dir,
    activity: await directoryActivity(dir),
  })));
  return ranked.sort((left, right) => right.activity - left.activity).slice(0, limit).map((entry) => entry.dir);
}

async function directoryActivity(dir: string): Promise<number> {
  const candidates = [
    join(dir, "status.json"),
    join(dir, "artifacts", "status.json"),
    join(dir, "events.jsonl"),
    join(dir, "artifacts", "events.jsonl"),
    dir,
  ];
  for (const candidate of candidates) {
    try {
      return (await stat(candidate)).mtimeMs;
    } catch {}
  }
  return 0;
}

function currentRuns(runs: RunSummary[]): RunSummary[] {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = runGroupKey(run);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  const activeKeys = new Set<string>();
  const active = runs.filter((run) => ["running", "waiting"].includes(run.health.state) || recentlyActiveUnknown(run))
    .map((run) => {
      const key = runGroupKey(run);
      activeKeys.add(key);
      return { ...run, category: "active" as const, attemptCount: groups.get(key)?.length ?? 1 };
    });
  const latest = [...groups.entries()].filter(([key]) => !activeKeys.has(key)).map(([, attempts]) => {
    const ordered = attempts.sort(compareRuns);
    return { ...ordered[0], attemptCount: ordered.length };
  });
  const attention = latest.filter((run) => ["failed", "interrupted"].includes(run.health.state))
    .map((run) => ({ ...run, category: "attention" as const }));
  const recent = latest.filter((run) => run.health.state === "succeeded")
    .sort(compareRuns)
    .slice(0, 5)
    .map((run) => ({ ...run, category: "recent" as const }));
  return [...active, ...attention, ...recent];
}

const RECENT_UNKNOWN_ACTIVITY_MS = 10 * 60 * 1000;

function recentlyActiveUnknown(run: RunSummary): boolean {
  if (run.health.state !== "unknown") return false;
  if (run.lastActivity === undefined) return false;
  return Date.now() - Date.parse(run.lastActivity) < RECENT_UNKNOWN_ACTIVITY_MS;
}

function runGroupKey(run: RunSummary): string {
  return `${run.project ?? "unknown"}\u0000${runFamily(run)}`;
}

function runFamily(run: RunSummary): string {
  if (run.workflow === "dispatch") return "dispatch";
  if (run.operation?.startsWith("dispatch/")) return "dispatch";
  if (run.events.some((event) => event.details.operationPath?.startsWith("dispatch/"))) return "dispatch";
  return run.workflow ?? run.operation ?? "run";
}

async function readSafeRun(runDir: string): Promise<RunSummary | undefined> {
  try {
    return await readRun(runDir);
  } catch {
    return undefined;
  }
}

function compareRuns(left: RunSummary, right: RunSummary): number {
  const leftActive = ["running", "waiting"].includes(left.health.state);
  const rightActive = ["running", "waiting"].includes(right.health.state);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  return right.lastActivity.localeCompare(left.lastActivity);
}

async function profileSummaries(): Promise<ProfileSummary[]> {
  const profiles = await readCodexProfiles();
  const state = await readCodexRoutingState();

  return profiles.map((profile) => {
    const assignments = Object.values(state.reservations).filter((entry) => entry.profile === profile.name);
    const circuit = state.circuits[profile.name];
    return {
      name: profile.name,
      enabled: profile.enabled,
      profileClass: profile.profileClass,
      activeAssignments: assignments.length,
      capacityClass: circuitIsOpen(circuit) ? "circuit-open" : assignments.length ? "assigned" : "unobserved",
      circuitState: circuitIsOpen(circuit) ? "open" : "closed",
    };
  });
}
