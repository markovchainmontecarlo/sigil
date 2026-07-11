import { z } from "zod";

export const MigrationItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  intent: z.string().min(1),
  brief: z.string().min(1),
  focus: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string()).default([]),
  commitMessage: z.string().min(1),
});

export const MigrationBacklogSchema = z.object({
  contractVersion: z.literal(1),
  goal: z.string().min(1),
  protectedPaths: z.array(z.string().min(1)).default([]),
  items: z.array(MigrationItemSchema).min(1),
});

export type MigrationItem = z.infer<typeof MigrationItemSchema>;
export type MigrationBacklog = z.infer<typeof MigrationBacklogSchema>;

export function parseMigrationBacklog(value: unknown): MigrationBacklog {
  const backlog = MigrationBacklogSchema.parse(value);
  validateDependencies(backlog.items);
  return backlog;
}

export function orderMigrationItems(items: MigrationItem[]): MigrationItem[] {
  const remaining = new Map(items.map((item) => [item.id, item]));
  const ordered: MigrationItem[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((item) =>
      item.dependsOn.every((dependency) => !remaining.has(dependency)),
    );
    if (!ready.length) throw new Error("migration backlog contains a dependency cycle");
    for (const item of ready) {
      ordered.push(item);
      remaining.delete(item.id);
    }
  }
  return ordered;
}

function validateDependencies(items: MigrationItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`duplicate migration item id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`migration item ${item.id} has unknown dependency: ${dependency}`);
      }
      if (dependency === item.id) {
        throw new Error(`migration item ${item.id} depends on itself`);
      }
    }
  }
  orderMigrationItems(items);
}
