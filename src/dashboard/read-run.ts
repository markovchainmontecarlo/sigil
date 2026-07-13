import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { processIdentityIsAlive, readProcessIdentity, type ProcessIdentity } from "../process-identity.js";
import type { DispatchCheckpoint } from "../workflows/dispatch/state.js";
import type { DispatchItemSummary, DispatchSummary, GateSummary, RunEvent, RunHealth, RunProgress, RunSummary, RunState, WorkSummary } from "./types.js";

const EVENT_LIMIT = 30;

type StatusRecord = {
  state?: string;
  stage?: string;
  operationPath?: string;
  gate?: string;
  updatedAt?: string;
  at?: string;
  message?: string;
  pid?: number;
  processIdentity?: ProcessIdentity;
};

type ManifestRecord = {
  repo?: string;
  file?: string;
};

type RuntimeRecord = {
  binding?: string;
  profile?: string;
  childProcessId?: number;
  childStartIdentity?: string;
  active?: boolean;
};

type TaskCheckpoint = {
  tasks?: Record<string, { status?: string }>;
};

type TaskGraph = {
  goal?: string;
  tasks?: Array<{ id?: string; title?: string; dependencies?: string[] }>;
};

type WorkState = {
  progress?: RunProgress;
  summary?: WorkSummary;
};

type Backlog = {
  mission?: string;
  items?: Array<{ id?: string; goal?: string; dependsOn?: string[] }>;
};

export async function readRun(runDir: string): Promise<RunSummary> {
  const warnings: string[] = [];
  const manifest = await readJson<ManifestRecord>(join(runDir, "manifest.json"), warnings);
  const status = await readStatus(runDir, warnings);
  const dispatch = await readJson<DispatchCheckpoint>(join(runDir, "artifacts", "dispatch-state.json"), warnings);
  const runtime = await readJson<RuntimeRecord>(join(runDir, "artifacts", "dispatch-runtime.json"), warnings);
  const eventsFile = await existingFile(
    join(runDir, "events.jsonl"),
    join(runDir, "artifacts", "events.jsonl"),
  );
  const events = eventsFile ? await readEventTail(eventsFile, warnings) : [];
  const health = await deriveHealth(runDir, status, dispatch, warnings);
  const backlog = await readBacklogState(dispatch, warnings);
  const work = await readWorkState(runDir, dispatch, warnings);
  const dispatchSummary = await readDispatchSummary(runDir, dispatch, warnings);
  const gates = gateSummaries(events);

  return {
    id: createHash("sha256").update(resolve(runDir)).digest("hex").slice(0, 16),
    project: manifest?.repo ? projectName(manifest.repo) : dispatch?.repository ? projectName(dispatch.repository) : projectFromPath(runDir),
    workflow: manifest?.file ? basename(manifest.file) : dispatch ? "dispatch" : undefined,
    stage: status?.stage ?? status?.state ?? dispatch?.active?.stage,
    operation: status?.operationPath ?? dispatch?.operation?.type,
    gate: status?.gate,
    binding: runtime?.binding ?? dispatch?.operation?.agent?.binding,
    profile: runtime?.profile,
    lastActivity: await lastActivity(runDir, status, events),
    health,
    backlog: backlog.progress,
    backlogWork: backlog.summary,
    dispatch: dispatchSummary,
    tasks: work.progress,
    work: work.summary,
    activity: activitySummary(dispatch, status, events, gates),
    gates,
    failure: failureMessage(status, events),
    events,
    warnings,
  };
}

async function readDispatchSummary(
  runDir: string,
  dispatch: DispatchCheckpoint | undefined,
  warnings: string[],
): Promise<DispatchSummary | undefined> {
  if (!dispatch) return undefined;
  const backlog = await readJson<Backlog>(dispatch.backlogFile, warnings);
  if (!backlog?.items?.length) return undefined;

  const delivered = new Set(dispatch.delivered.map((item) => item.id));
  const items = await Promise.all(backlog.items.flatMap((item) => {
    if (!item.id || !safeItemId(item.id)) return [];
    return [readDispatchItem(runDir, item, dispatch, delivered, warnings)];
  }));
  const completedItemPaces = items.flatMap((item) => {
    const completed = item.progress?.completed ?? 0;
    if (item.status !== "completed" || !item.elapsedMs || !completed) return [];
    return [item.elapsedMs / completed];
  });
  const taskSamples = items.flatMap((item) => taskDurations(item.events)).slice(-8);
  const typicalTaskMs = median(completedItemPaces.length ? completedItemPaces : taskSamples);
  const estimateBasis = completedItemPaces.length
    ? items.filter((item) => item.status === "completed").reduce((sum, item) => sum + (item.progress?.completed ?? 0), 0)
    : taskSamples.length;
  const summaries = items.map(({ events: _events, ...item }) => estimateDispatchItem(item, typicalTaskMs));
  const completedKnownTasks = summaries.reduce((sum, item) => sum + (item.progress?.completed ?? 0), 0);
  const totalKnownTasks = summaries.reduce((sum, item) => sum + (item.progress?.total ?? 0), 0);
  const estimatedRemainingMs = typicalTaskMs === undefined
    ? undefined
    : typicalTaskMs * Math.max(0, totalKnownTasks - completedKnownTasks);

  return {
    goal: backlog.mission,
    items: summaries,
    completedKnownTasks,
    totalKnownTasks,
    estimatedRemainingMs,
    estimateBasis,
    unplannedItems: summaries.filter((item) => !item.work).length,
  };
}

async function readDispatchItem(
  runDir: string,
  item: NonNullable<Backlog["items"]>[number],
  dispatch: DispatchCheckpoint,
  delivered: Set<string>,
  warnings: string[],
): Promise<DispatchItemSummary & { events: RunEvent[] }> {
  const root = join(runDir, "artifacts", "dispatch", item.id!);
  const graphFile = await existingFile(join(root, "implementation", "task-graph.json"), join(root, "task-graph.json"));
  const checkpointFile = await existingFile(join(root, "implementation", "checkpoint.json"), join(root, "checkpoint.json"));
  const eventsFile = await existingFile(join(root, "events.jsonl"));
  const graph = graphFile ? await readJson<TaskGraph>(graphFile, warnings) : undefined;
  const checkpoint = checkpointFile ? await readJson<TaskCheckpoint>(checkpointFile, warnings) : undefined;
  const events = eventsFile ? await readAllEvents(eventsFile, warnings) : [];
  const status = delivered.has(item.id!) ? "completed" : item.id === dispatch.active?.id ? "running" : "pending";

  return {
    id: item.id!,
    title: item.goal ?? item.id!,
    status,
    progress: taskProgress(checkpoint),
    work: workSummary(graph, checkpoint),
    elapsedMs: elapsedTime(events),
    events,
  };
}

function estimateDispatchItem(item: DispatchItemSummary, typicalTaskMs: number | undefined): DispatchItemSummary {
  const remaining = Math.max(0, (item.progress?.total ?? 0) - (item.progress?.completed ?? 0));
  return {
    ...item,
    estimatedRemainingMs: typicalTaskMs === undefined || !item.work ? undefined : typicalTaskMs * remaining,
  };
}

function taskDurations(events: RunEvent[]): number[] {
  const starts = new Map<string, number>();
  const durations: number[] = [];
  for (const event of events) {
    const task = event.details.task;
    const at = event.at ? Date.parse(event.at) : Number.NaN;
    if (!task || Number.isNaN(at)) continue;
    if (event.stage === "task-started") starts.set(task, at);
    if (event.stage !== "task-completed" || !starts.has(task)) continue;
    durations.push(at - starts.get(task)!);
    starts.delete(task);
  }
  return durations.filter((duration) => duration >= 0);
}

function elapsedTime(events: RunEvent[]): number | undefined {
  const timestamps = events.flatMap((event) => event.at ? [Date.parse(event.at)] : []).filter(Number.isFinite);
  if (timestamps.length < 2) return undefined;
  return timestamps.at(-1)! - timestamps[0];
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeItemId(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

async function readStatus(runDir: string, warnings: string[]): Promise<StatusRecord | undefined> {
  return await readJson<StatusRecord>(join(runDir, "status.json"), warnings)
    ?? await readJson<StatusRecord>(join(runDir, "artifacts", "status.json"), warnings);
}

async function deriveHealth(
  runDir: string,
  status: StatusRecord | undefined,
  dispatch: DispatchCheckpoint | undefined,
  warnings: string[],
): Promise<RunHealth> {
  const terminal = terminalState(status?.state) ?? terminalState(dispatch?.operation?.status);
  if (terminal) return { state: terminal, process: "dead" };

  const owner = await readJson<ProcessIdentity>(join(runDir, "dispatch.lock", "owner.json"), warnings);
  const identity = owner ?? statusIdentity(status);
  if (!identity) return await healthFromRecordedPid(runDir, status);

  const alive = await processIdentityIsAlive(identity);
  if (alive) return { state: waitingState(dispatch) ? "waiting" : "running", process: "alive" };
  return { state: "stale", process: "dead", warning: "Recorded owner process is not running." };
}

function statusIdentity(status: StatusRecord | undefined): ProcessIdentity | undefined {
  return status?.processIdentity;
}

async function healthFromRecordedPid(
  runDir: string,
  status: StatusRecord | undefined,
): Promise<RunHealth> {
  if (!status?.pid) return { state: "unknown", process: "unverified", warning: "No process identity is available." };

  try {
    const identity = await readProcessIdentity(status.pid);
    const recordedAt = await statusModifiedAt(runDir);
    const startedAt = Date.parse(identity.startIdentity);
    if (Number.isNaN(startedAt) || startedAt > recordedAt) {
      return { state: "stale", process: "unverified", warning: "The recorded PID may have been reused." };
    }
    return { state: "running", process: "alive" };
  } catch {
    return { state: "stale", process: "dead", warning: "Recorded owner process is not running." };
  }
}

async function statusModifiedAt(runDir: string): Promise<number> {
  const file = await existingFile(join(runDir, "status.json"), join(runDir, "artifacts", "status.json"));
  return file ? (await stat(file)).mtimeMs : 0;
}

function terminalState(value: string | undefined): RunState | undefined {
  if (value === "succeeded" || value === "completed") return "succeeded";
  if (value === "failed") return "failed";
  if (value === "interrupted") return "interrupted";
  return undefined;
}

function waitingState(dispatch: DispatchCheckpoint | undefined): boolean {
  return dispatch?.operation?.status === "capacity-blocked";
}

async function readBacklogState(
  dispatch: DispatchCheckpoint | undefined,
  warnings: string[],
): Promise<WorkState> {
  if (!dispatch) return {};
  const backlog = await readJson<Backlog>(dispatch.backlogFile, warnings);
  const delivered = new Set(dispatch.delivered.map((item) => item.id));
  const tasks = (backlog?.items ?? []).flatMap((item) => {
    if (!item.id) return [];
    const status = delivered.has(item.id) ? "completed" : item.id === dispatch.active?.id ? "running" : "pending";
    return [{ id: item.id, title: item.goal ?? item.id, status, dependencies: item.dependsOn ?? [] }];
  });
  return {
    progress: {
      completed: dispatch.delivered.length,
      total: backlog?.items?.length,
      label: dispatch.active?.id ?? "Backlog delivery",
    },
    summary: tasks.length ? { goal: backlog?.mission, tasks } : undefined,
  };
}

function activitySummary(
  dispatch: DispatchCheckpoint | undefined,
  status: StatusRecord | undefined,
  events: RunEvent[],
  gates: GateSummary[],
): { label: string; detail?: string } | undefined {
  const latest = events.at(-1);
  if (latest?.stage === "gate-started" && latest.details.gate) {
    return {
      label: `Running ${gateName(latest.details.gate)}`,
      detail: gateResultSummary(gates),
    };
  }
  if (latest?.stage === "agent-started" && hasFailedVerification(events)) {
    return {
      label: "Repairing failed verification",
      detail: "A repair agent is addressing the latest failed verification.",
    };
  }
  if (latest?.stage === "agent-started" && hasPassedVerification(events)) {
    return {
      label: "Reviewing completed changes",
      detail: reviewProgress(events),
    };
  }
  if (dispatch?.operation?.status === "recovering") {
    return { label: "Recovering interrupted work", detail: dispatch.operation.failure?.evidence };
  }
  if (dispatch?.operation?.status === "capacity-blocked") {
    return { label: "Waiting for provider capacity", detail: dispatch.operation.failure?.evidence };
  }
  if (dispatch?.active?.id) {
    return { label: `Working on ${dispatch.active.id}`, detail: dispatch.operation?.type };
  }
  if (status?.stage) return { label: humanize(status.stage) };
  return undefined;
}

function reviewProgress(events: RunEvent[]): string {
  const verification = lastVerificationIndex(events);
  const reviewEvents = events.slice(verification + 1);
  const started = reviewEvents.filter((event) => event.stage === "agent-started").length;
  const completed = reviewEvents.filter((event) => event.stage === "agent-completed").length;
  const active = Math.max(0, started - completed);
  return `Final verification passed. ${completed} review operations completed; ${active} active.`;
}

function lastVerificationIndex(events: RunEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].stage === "final-verification") return index;
  }
  return -1;
}

function gateName(gate: string): string {
  if (gate === "e2e") return "end-to-end tests";
  if (gate === "test") return "unit tests";
  if (gate === "verify") return "final verification";
  return gate;
}

function gateResultSummary(gates: GateSummary[]): string | undefined {
  if (!gates.length) return undefined;
  return `This verification pass: ${gates.map((gate) => `${gateName(gate.name)} ${gate.outcome}`).join(", ")}.`;
}

function hasFailedVerification(events: RunEvent[]): boolean {
  return latestVerificationOutcome(events) === "failed";
}

function hasPassedVerification(events: RunEvent[]): boolean {
  return latestVerificationOutcome(events) === "passed";
}

function latestVerificationOutcome(events: RunEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.stage === "final-verification" && event.details.outcome) return event.details.outcome;
  }
  return undefined;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function taskProgress(checkpoint: TaskCheckpoint | undefined): RunProgress | undefined {
  if (!checkpoint?.tasks) return undefined;
  const entries = Object.entries(checkpoint.tasks);
  const tasks = entries.map(([, task]) => task);
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
    label: "Implementation tasks",
    active: entries.filter(([, task]) => task.status === "running").map(([id]) => id),
    failed: tasks.filter((task) => task.status === "failed").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
  };
}

async function readWorkState(
  runDir: string,
  dispatch: DispatchCheckpoint | undefined,
  warnings: string[],
): Promise<WorkState> {
  const checkpointFile = await workFile(runDir, dispatch?.active?.implementationCheckpointFile, "checkpoint.json");
  const taskGraphFile = await workFile(runDir, dispatch?.active?.taskFile, "task-graph.json");
  const checkpoint = checkpointFile ? await readJson<TaskCheckpoint>(checkpointFile, warnings) : undefined;
  const taskGraph = taskGraphFile ? await readJson<TaskGraph>(taskGraphFile, warnings) : undefined;

  return {
    progress: taskProgress(checkpoint),
    summary: workSummary(taskGraph, checkpoint),
  };
}

async function workFile(
  runDir: string,
  preferred: string | undefined,
  fallbackName: string,
): Promise<string | undefined> {
  if (preferred && safeRunPath(runDir, preferred)) return preferred;
  return await existingFile(
    join(runDir, "artifacts", "implementation", fallbackName),
    join(runDir, "artifacts", fallbackName),
  );
}

function workSummary(taskGraph: TaskGraph | undefined, checkpoint: TaskCheckpoint | undefined): WorkSummary | undefined {
  if (!taskGraph?.tasks?.length) return undefined;
  const tasks = taskGraph.tasks.flatMap((task) => {
    if (!task.id) return [];
    return [{
      id: task.id,
      title: task.title ?? task.id,
      status: checkpoint?.tasks?.[task.id]?.status ?? "pending",
      dependencies: task.dependencies ?? [],
    }];
  });
  return { goal: taskGraph.goal, tasks };
}

function gateSummaries(events: RunEvent[]): GateSummary[] {
  const gates = new Map<string, GateSummary>();
  for (const event of currentVerificationEvents(events)) {
    if (event.stage !== "gate-completed" || !event.details.gate) continue;
    gates.set(event.details.gate, {
      name: event.details.gate,
      outcome: event.details.outcome ?? "unknown",
      command: event.details.command,
      exitCode: event.details.exitCode,
    });
  }
  return [...gates.values()];
}

function currentVerificationEvents(events: RunEvent[]): RunEvent[] {
  let start = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.stage === "final-verification" && !event.details.outcome) start = index + 1;
    if (event.stage === "gate-started" && event.details.gate === "build") start = index;
  }
  return events.slice(start);
}

function failureMessage(status: StatusRecord | undefined, events: RunEvent[]): string | undefined {
  if (status?.state === "failed" && status.message) return status.message;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.stage === "workflow-failed" || event.stage === "agent-failed") {
      return event.details.error ?? event.details.message;
    }
  }
  return undefined;
}

function safeRunPath(runDir: string, file: string): boolean {
  if (!isAbsolute(file)) return false;
  const rel = relative(resolve(runDir), resolve(file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function projectFromPath(runDir: string): string | undefined {
  const managed = managedWorkspaceProject(runDir);
  if (managed) return managed;
  const marker = `${join(".sigil", "runs")}`;
  const index = runDir.lastIndexOf(marker);
  if (index < 1) return undefined;
  return basename(runDir.slice(0, index));
}

function projectName(repo: string): string {
  const managed = managedWorkspaceProject(repo);
  if (managed) return managed;
  const parent = basename(resolve(repo, ".."));
  if (parent === "sigil-worktrees") return "sigil";
  return basename(repo);
}

function managedWorkspaceProject(path: string): string | undefined {
  const parts = resolve(path).split("/");
  const projects = parts.lastIndexOf("projects");
  if (projects < 0 || parts[projects - 1] !== "workspaces") return undefined;
  return parts[projects + 1];
}

async function readEventTail(file: string, warnings: string[]): Promise<RunEvent[]> {
  const events = await readAllEvents(file, warnings);
  const useful = events.filter(isUsefulEvent);
  return (useful.length ? useful : events).slice(-EVENT_LIMIT);
}

async function readAllEvents(file: string, warnings: string[]): Promise<RunEvent[]> {
  try {
    const contents = await readFile(file, "utf8");
    return contents.trim().split("\n").flatMap(parseEvent);
  } catch (error) {
    warnings.push(`Could not read events: ${errorMessage(error)}`);
    return [];
  }
}

function isUsefulEvent(event: RunEvent): boolean {
  return !["agent-progress", "agent-heartbeat", "agent-waiting", "agent-capacity"].includes(event.stage);
}

function parseEvent(line: string): RunEvent[] {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const stage = typeof value.stage === "string" ? value.stage : "unknown";
    const at = typeof value.at === "string" ? value.at : undefined;
    const details = Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => key !== "at" && key !== "stage" && typeof item === "string")) as Record<string, string>;
    return [{ at, stage, details }];
  } catch {
    return [];
  }
}

async function lastActivity(
  runDir: string,
  status: StatusRecord | undefined,
  events: RunEvent[],
): Promise<string> {
  const eventTime = events.at(-1)?.at;
  if (eventTime) return eventTime;
  if (status?.at) return status.at;
  if (status?.updatedAt) return status.updatedAt;
  return (await stat(runDir)).mtime.toISOString();
}

async function existingFile(...files: string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  return undefined;
}

async function readJson<T>(file: string, warnings: string[]): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warnings.push(`Could not read ${basename(file)}: ${errorMessage(error)}`);
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
