import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  resolveConfig,
  resolveEvalCommand,
  resolveEvalPlan,
  type EvalDefinition,
  type SigilConfig,
} from "./config.js";
import { git } from "./git.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type PackageManifest = {
  packageManager?: unknown;
  scripts?: unknown;
};

const LOCKFILES: Record<PackageManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const DISCOVERED_GATES = ["build", "test", "verify"] as const;
const EMPTY_TEST_SCRIPT = /(?:no test specified|no tests? configured)/i;

export async function resolveRepositoryRoot(path: string): Promise<string> {
  const requested = resolve(path);
  const result = await git(requested, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? resolve(result.stdout.trim()) : requested;
}

export async function discoverProjectEvals(repo: string): Promise<Record<string, EvalDefinition>> {
  const manifest = await readPackageManifest(repo);
  const packageManager = manifest ? await detectPackageManager(repo, manifest) : undefined;
  const scripts = packageScripts(manifest);
  if (!packageManager || !scripts) return {};

  return Object.fromEntries(DISCOVERED_GATES.flatMap((name) => {
    const script = scripts[name];
    if (!isUsableScript(name, script)) return [];
    return [[name, `${packageManager} run ${name}`]];
  }));
}

export function requireImplementationVerification(repo: string): SigilConfig {
  const resolved = resolveConfig(repo);
  const requested = ["build", "test"];
  const executable = resolveEvalPlan(requested, resolved.config)
    .filter((name) => resolveEvalCommand(name, resolved.config) !== undefined);
  if (executable.length > 0) return resolved.config;

  throw new Error([
    `No build or test commands are configured in ${resolved.configPath}.`,
    "Add repository verification commands under `evals` before running implementation.",
  ].join("\n"));
}

async function readPackageManifest(repo: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(resolve(repo, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

async function detectPackageManager(
  repo: string,
  manifest: PackageManifest,
): Promise<PackageManager | undefined> {
  const declared = declaredPackageManager(manifest.packageManager);
  if (declared) return declared;

  const detected = await Promise.all(Object.entries(LOCKFILES).map(async ([manager, files]) => (
    await anyFileExists(repo, files) ? manager as PackageManager : undefined
  )));
  const present = detected.filter((manager): manager is PackageManager => manager !== undefined);
  return present.length === 1 ? present[0] : undefined;
}

function declaredPackageManager(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.split("@", 1)[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : undefined;
}

function packageScripts(manifest: PackageManifest | undefined): Record<string, unknown> | undefined {
  if (!manifest || typeof manifest.scripts !== "object" || manifest.scripts === null) return undefined;
  if (Array.isArray(manifest.scripts)) return undefined;
  return manifest.scripts as Record<string, unknown>;
}

function isUsableScript(name: string, value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return name !== "test" || !EMPTY_TEST_SCRIPT.test(value);
}

async function anyFileExists(repo: string, files: string[]): Promise<boolean> {
  const results = await Promise.all(files.map(async (file) => {
    try {
      await access(resolve(repo, file));
      return true;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
}
