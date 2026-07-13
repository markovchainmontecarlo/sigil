import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

export const CONTRACT_VERSION = 1;

export const TaskFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete"]),
  details: z.array(z.string().min(1)).min(1),
}).strict();

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  dependencies: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  diagrams: z.array(z.string()).default([]),
  files: z.array(TaskFileSchema),
}).strict();

export const TaskGraphSchema = z.object({
  $schema: z.string().min(1).optional(),
  contractVersion: z.literal(CONTRACT_VERSION),
  project: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  goal: z.string().min(1).optional(),
  tasks: z.array(TaskSchema).min(1),
}).strict();

export const taskGraphJsonSchema = z.toJSONSchema(TaskGraphSchema, {
  target: "draft-07",
  io: "input",
});

export type FileAction = z.input<typeof TaskFileSchema>["action"];
export type TaskFile = z.output<typeof TaskFileSchema>;
export type Task = z.output<typeof TaskSchema>;
export type TaskGraph = Omit<z.output<typeof TaskGraphSchema>, "$schema">;

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

function structuralErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "task graph";
    return `${path}: ${issue.message}`;
  });
}

function normalizedGraph(document: z.output<typeof TaskGraphSchema>): TaskGraph {
  const { $schema: _schema, ...graph } = document;
  return graph;
}

/** Collect all contract violations without throwing. */
export function checkTaskGraph(raw: unknown, options: TaskGraphCheckOptions = {}): TaskGraphCheck {
  const parsed = TaskGraphSchema.safeParse(raw);
  if (!parsed.success) return { graph: null, errors: structuralErrors(parsed.error) };

  const errors: string[] = [];
  const resolvedRoot = options.repoRoot === undefined ? undefined : resolve(options.repoRoot);
  const ids = new Set<string>();
  const tasks = parsed.data.tasks.map((task) => {
    if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    ids.add(task.id);

    const files = task.files.map((file) => {
      const path = resolveTaskPath(file.path, resolvedRoot);
      if (!isAbsolute(file.path) && resolvedRoot === undefined) {
        errors.push(`task ${task.id} file path is relative but no repo root was provided: ${file.path}`);
      }
      if (resolvedRoot !== undefined && escapesRoot(path, resolvedRoot)) {
        errors.push(`task ${task.id} file path escapes repo root: ${file.path}`);
      }
      return { ...file, path };
    });

    return { ...task, files };
  });

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) errors.push(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }

  const dependencies = Object.fromEntries(tasks.map((task) => [task.id, task.dependencies.filter((id) => ids.has(id))]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const cycles = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      cycles.add(id);
      return;
    }
    visiting.add(id);
    for (const dependency of dependencies[id] ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) visit(id);
  for (const id of cycles) errors.push(`dependency cycle through task: ${id}`);

  return {
    graph: { ...normalizedGraph(parsed.data), tasks },
    errors,
  };
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
