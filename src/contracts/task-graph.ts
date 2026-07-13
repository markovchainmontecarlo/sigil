import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

export const CONTRACT_VERSION = 1;

export type FileAction = "create" | "modify" | "delete";

export interface TaskFile {
  path: string;
  action: FileAction;
  details: string[];
}
export interface Task {
  id: string;
  title: string;
  summary: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  diagrams: string[];
  files: TaskFile[];
}

export interface TaskGraph {
  contractVersion: number;
  project: string;
  goal?: string;
  tasks: Task[];
}

export interface TaskGraphCheckOptions {
  repoRoot?: string;
}

export interface TaskGraphCheck {
  graph: TaskGraph | null;
  errors: string[];
}

function resolveTaskPath(path: string, repoRoot: string | undefined): string {
  if (repoRoot === undefined || isAbsolute(path)) return resolve(path);
  return resolve(repoRoot, path);
}

function escapesRoot(path: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, path);
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
}

/** Collect all contract violations without throwing. */
export function checkTaskGraph(raw: unknown, options: TaskGraphCheckOptions = {}): TaskGraphCheck {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object") return { graph: null, errors: ["task graph is not an object"] };
  const g = raw as Record<string, unknown>;
  if (g.contractVersion !== undefined && g.contractVersion !== CONTRACT_VERSION) {
    errors.push(`unsupported task-graph contractVersion ${String(g.contractVersion)}; expected ${CONTRACT_VERSION}`);
  }
  if (!Array.isArray(g.tasks) || g.tasks.length === 0) {
    errors.push("task graph has no tasks");
    return { graph: null, errors };
  }
  if (typeof g.project !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(g.project)) {
    errors.push(`project must be a short kebab-case slug (got "${String(g.project ?? "")}")`);
  }
  const tasks = g.tasks as Task[];
  const resolvedRoot = options.repoRoot === undefined ? undefined : resolve(options.repoRoot);
  const ids = new Set<string>();
  const normalizedTasks: Task[] = [];
  for (const t of tasks) {
    const label = typeof t.id === "string" && t.id ? t.id : "(unknown)";
    if (typeof t.id !== "string" || !t.id) errors.push("task missing id");
    else {
      if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
      ids.add(t.id);
    }
    if (typeof t.title !== "string" || !t.title) errors.push(`task ${label} missing title`);
    if (typeof t.summary !== "string" || !t.summary) errors.push(`task ${label} missing summary`);
    if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length === 0 || t.acceptanceCriteria.some((c) => typeof c !== "string" || !c)) errors.push(`task ${label} acceptanceCriteria must be a non-empty array of non-empty strings`);
    if (!Array.isArray(t.diagrams) || t.diagrams.some((d) => typeof d !== "string")) errors.push(`task ${label} diagrams must be an array of strings`);
    const files: TaskFile[] = [];
    if (!Array.isArray(t.files)) errors.push(`task ${label} missing files[]`);
    else for (const f of t.files) {
      let path = typeof f.path === "string" ? f.path : "";
      if (!path) {
        errors.push(`task ${label} file path must be a non-empty string`);
      } else if (!isAbsolute(path) && resolvedRoot === undefined) {
        errors.push(`task ${label} file path is relative but no repo root was provided: ${path}`);
      } else if (resolvedRoot !== undefined) {
        path = resolveTaskPath(path, resolvedRoot);
        if (escapesRoot(path, resolvedRoot)) errors.push(`task ${label} file path escapes repo root: ${String(f.path)}`);
      }
      if (!["create", "modify", "delete"].includes(f.action)) errors.push(`task ${label} file ${String(f.path)} has invalid action: ${String(f.action)}`);
      if (!Array.isArray(f.details) || f.details.length === 0 || f.details.some((d) => typeof d !== "string" || !d)) errors.push(`task ${label} file ${String(f.path)} details must be a non-empty array of non-empty strings`);
      files.push({ ...f, path });
    }
    normalizedTasks.push({ ...t, files });
  }
  for (const t of tasks) {
    const label = typeof t.id === "string" ? t.id : "(unknown)";
    if (t.dependencies !== undefined && !Array.isArray(t.dependencies)) {
      errors.push(`task ${label} dependencies must be an array`);
      continue;
    }
    for (const d of t.dependencies ?? []) if (!ids.has(d)) errors.push(`task ${label} depends on unknown task: ${d}`);
  }
  const deps = (t: Task): string[] => (Array.isArray(t.dependencies) ? t.dependencies : []).filter((d) => ids.has(d));
  const dep: Record<string, string[]> = Object.fromEntries(tasks.filter((t) => typeof t.id === "string").map((t) => [t.id, deps(t)]));
  const done: Record<string, boolean> = {};
  const cycles = new Set<string>();
  const visit = (id: string, stack: Set<string>): void => {
    if (done[id]) return;
    if (stack.has(id)) { cycles.add(id); return; }
    stack.add(id);
    for (const d of dep[id] ?? []) visit(d, stack);
    stack.delete(id);
    done[id] = true;
  };
  for (const id of ids) visit(id, new Set());
  for (const id of cycles) errors.push(`dependency cycle through task: ${id}`);
  const graph: TaskGraph = { contractVersion: CONTRACT_VERSION, project: String(g.project ?? ""), goal: g.goal as string | undefined, tasks: normalizedTasks };
  return { graph, errors };
}

export function validateTaskGraph(raw: unknown, options: TaskGraphCheckOptions = {}): TaskGraph {
  const { graph, errors } = checkTaskGraph(raw, options);
  if (errors.length || !graph) throw new Error(errors[0] ?? "invalid task graph");
  return graph;
}

export function canonicalTaskGraph(graph: TaskGraph): string {
  return JSON.stringify(sortObject(graph));
}

export function taskGraphDigest(graph: TaskGraph): string {
  return createHash("sha256").update(canonicalTaskGraph(graph)).digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObject(entry)]));
  }
  return value;
}

export function orderedTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task, index) => [task.id, { task, index }]));
  const placed = new Set<string>();
  const result: Task[] = [];
  while (result.length < tasks.length) {
    const next = tasks
      .filter((task) => !placed.has(task.id) && task.dependencies.every((dependency) => placed.has(dependency)))
      .sort((left, right) => byId.get(left.id)!.index - byId.get(right.id)!.index)[0];
    if (!next) throw new Error("cycle in task graph");
    placed.add(next.id);
    result.push(next);
  }
  return result;
}
