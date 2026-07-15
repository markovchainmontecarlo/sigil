import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Replace {{key}} placeholders; an unprovided key is left visible as {{key}}. */
export function interpolate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => (key in vars ? String(vars[key]) : `{{${key}}}`));
}

const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

export type Prompt = (vars?: Record<string, unknown>) => string;
export type PromptGroup = Record<string, Prompt>;

const MODULE_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(MODULE_FILE));
const RESOURCE_ROOT = extname(MODULE_FILE) === ".ts"
  ? join(PACKAGE_ROOT, "src")
  : join(PACKAGE_ROOT, "resources");
const RESOURCE_PREFIXES = ["workflows/", "dashboard/public/"];
let installedResources: Set<string> | undefined;

export function packageResource(identifier: string): string {
  const segments = identifier.split("/");
  if (isAbsolute(identifier) || identifier.includes("\\") || segments.some((segment) => !SEGMENT.test(segment))) {
    throw new Error(`invalid resource identifier: ${identifier}`);
  }
  if (!RESOURCE_PREFIXES.some((prefix) => identifier.startsWith(prefix))) {
    throw new Error(`undeclared resource identifier: ${identifier}`);
  }
  if (extname(MODULE_FILE) !== ".ts" && !resourceManifest().has(`resources/${identifier}`)) {
    throw new Error(`undeclared resource identifier: ${identifier}`);
  }
  const path = join(RESOURCE_ROOT, ...segments);
  if (!existsSync(path)) throw new Error(`resource not found: ${identifier}`);
  return path;
}

function resourceManifest(): Set<string> {
  if (installedResources) return installedResources;
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "resources-manifest.json"), "utf8")) as Array<{ path: string }>;
  installedResources = new Set(manifest.map((entry) => entry.path));
  return installedResources;
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
        return (vars = {}) => {
          if (!SEGMENT.test(name)) throw new Error(`invalid prompt path: ${name}`);

          const identifier = `${relativeRoot}/${name}.md`;
          try {
            return loadPromptTemplate(identifier, vars);
          } catch (error) {
            if (error instanceof Error && error.message === `resource not found: ${identifier}`) {
              throw new Error(`prompt not found: ${name}`);
            }
            throw error;
          }
        };
      },
    },
  );
}
