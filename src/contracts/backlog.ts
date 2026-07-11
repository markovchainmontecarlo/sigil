export const BACKLOG_CONTRACT_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export interface WorkItem {
  id: string;
  goal: string;
  dependsOn: string[];
  brief: string;
}

export interface Backlog {
  contractVersion: 1;
  mission: string;
  items: WorkItem[];
}

export interface BacklogCheck {
  backlog: Backlog | null;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Collect all backlog contract violations without throwing. */
export function checkBacklog(raw: unknown): BacklogCheck {
  const errors: string[] = [];
  if (!isRecord(raw)) return { backlog: null, errors: ["backlog is not an object"] };

  if (raw.contractVersion !== undefined && raw.contractVersion !== BACKLOG_CONTRACT_VERSION) {
    errors.push(`unsupported backlog contractVersion ${String(raw.contractVersion)}; expected ${BACKLOG_CONTRACT_VERSION}`);
  }
  if (!isNonEmptyString(raw.mission)) errors.push("backlog mission must be a non-empty string");
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    errors.push("backlog has no items");
    return { backlog: null, errors };
  }

  const items = raw.items as WorkItem[];
  const ids = new Set<string>();
  for (const item of raw.items) {
    if (!isRecord(item)) {
      errors.push("backlog item is not an object");
      continue;
    }

    const label = isNonEmptyString(item.id) ? item.id : "(unknown)";
    if (!isNonEmptyString(item.id)) errors.push("work item missing id");
    else {
      if (!ID_PATTERN.test(item.id)) errors.push(`work item ${item.id} id must be kebab-case`);
      if (ids.has(item.id)) errors.push(`duplicate work item id: ${item.id}`);
      ids.add(item.id);
    }
    if (!isNonEmptyString(item.goal)) errors.push(`work item ${label} missing goal`);
    if (!isNonEmptyString(item.brief)) errors.push(`work item ${label} missing brief`);
    if (!Array.isArray(item.dependsOn)) errors.push(`work item ${label} dependsOn must be an array`);
    else for (const dependency of item.dependsOn) {
      if (typeof dependency !== "string" || dependency.length === 0) errors.push(`work item ${label} dependsOn contains an invalid id`);
    }
  }

  for (const item of raw.items) {
    if (!isRecord(item)) continue;
    const label = typeof item.id === "string" ? item.id : "(unknown)";
    if (!Array.isArray(item.dependsOn)) continue;
    for (const dependency of item.dependsOn) {
      if (typeof dependency === "string" && dependency.length > 0 && !ids.has(dependency)) {
        errors.push(`work item ${label} depends on unknown item: ${dependency}`);
      }
    }
  }

  const deps = (item: WorkItem): string[] => (Array.isArray(item.dependsOn) ? item.dependsOn : []).filter((dependency) => ids.has(dependency));
  const dep: Record<string, string[]> = Object.fromEntries(
    items.filter((item) => typeof item.id === "string").map((item) => [item.id, deps(item)]),
  );
  const done: Record<string, boolean> = {};
  const cycles = new Set<string>();
  const visit = (id: string, stack: Set<string>): void => {
    if (done[id]) return;
    if (stack.has(id)) {
      cycles.add(id);
      return;
    }
    stack.add(id);
    for (const dependency of dep[id] ?? []) visit(dependency, stack);
    stack.delete(id);
    done[id] = true;
  };
  for (const id of ids) visit(id, new Set());
  for (const id of cycles) errors.push(`dependency cycle through work item: ${id}`);

  const backlog: Backlog = { contractVersion: BACKLOG_CONTRACT_VERSION, mission: String(raw.mission ?? ""), items };
  return { backlog, errors };
}

export function validateBacklog(raw: unknown): Backlog {
  const { backlog, errors } = checkBacklog(raw);
  if (errors.length || !backlog) throw new Error(errors[0] ?? "invalid backlog");
  return backlog;
}

export function orderItems(backlog: Backlog): WorkItem[] {
  const dep: Record<string, string[]> = Object.fromEntries(backlog.items.map((item) => [item.id, item.dependsOn ?? []]));
  const placed = new Set<string>();
  const levels: WorkItem[][] = [];
  while (placed.size < backlog.items.length) {
    const level = backlog.items.filter((item) => !placed.has(item.id) && dep[item.id].every((dependency) => placed.has(dependency)));
    if (!level.length) throw new Error("cycle in backlog");
    level.forEach((item) => placed.add(item.id));
    levels.push(level);
  }

  const order = levels.flat();
  const pos = Object.fromEntries(order.map((item, index) => [item.id, index]));
  for (const item of backlog.items) {
    for (const dependency of dep[item.id]) {
      if (pos[dependency] >= pos[item.id]) throw new Error(`dep-order violation: ${item.id} before ${dependency}`);
    }
  }
  return order;
}
