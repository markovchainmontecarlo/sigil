import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Replace {{key}} placeholders; an unprovided key is left visible as {{key}}. */
export function interpolate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in vars ? String(vars[key]) : `{{${key}}}`));
}

const SEGMENT = /^[a-zA-Z0-9]+$/;

function loadTemplateFromRoot(root: string, group: string, name: string): string {
  if ((group && !SEGMENT.test(group)) || !SEGMENT.test(name)) throw new Error(`invalid prompt path: ${group ? `${group}/` : ""}${name}`);
  const file = join(root, group, `${name}.md`);
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`prompt not found: ${group ? `${group}/` : ""}${name}`);
    throw error;
  }
}

export type Prompt = (vars?: Record<string, unknown>) => string;
export type PromptGroup = Record<string, Prompt>;

const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function packageResource(...segments: string[]): string {
  return join(DEFAULT_PACKAGE_ROOT, ...segments);
}

export function loadPromptTemplate(path: string, vars: Record<string, unknown> = {}): string {
  return interpolate(readFileSync(packageResource(path), "utf8"), vars);
}

export function createPromptGroup(relativeRoot: string): PromptGroup {
  return new Proxy(
    {},
    {
      get(_group, name): Prompt {
        if (typeof name !== "string") return undefined as unknown as Prompt;
        return (vars = {}) => interpolate(loadTemplateFromRoot(packageResource(relativeRoot), "", name), vars);
      },
    },
  );
}
