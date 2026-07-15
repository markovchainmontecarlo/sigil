#!/usr/bin/env bun
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";

import { taskGraphJsonSchema } from "../src/contracts/task-graph.js";

export const stagingRoot = join(process.cwd(), "dist", "package");

type RuntimeResourceGroup = {
  source: string;
  destination: string;
  files: readonly string[];
};

export const RUNTIME_RESOURCE_GROUPS: readonly RuntimeResourceGroup[] = [
  { source: "src/workflows/breakdown/prompts", destination: "workflows/breakdown/prompts", files: ["briefs.md", "cut.md", "fixJson.md", "merge.md"] },
  { source: "src/workflows/dispatch/prompts", destination: "workflows/dispatch/prompts", files: ["repair.md"] },
  { source: "src/workflows/probe/prompts", destination: "workflows/probe/prompts", files: ["buildTaskGraph.md", "design.md", "findings.md"] },
  { source: "src/workflows/refactor/prompts", destination: "workflows/refactor/prompts", files: ["analyze-risk.md", "analyze-structure.md", "implement-slice.md", "repair-protected-paths.md", "repair-review.md", "repair-slice.md", "review-behavior.md", "review-structure.md", "synthesize-plan.md"] },
  { source: "src/workflows/migrate/prompts", destination: "workflows/migrate/prompts", files: ["repair-final.md", "repair-protected-paths.md", "review-architecture.md", "review-behavior.md"] },
  { source: "src/workflows/software-change/planning/prompts", destination: "workflows/software-change/planning/prompts", files: ["buildTaskGraph.md", "comparePlans.md", "enrichTaskGraph.md", "fixJson.md", "investigate.md", "plannerRubric.md", "resolveDivergences.md", "synthesisRubric.md", "verifyClaims.md", "writePlan.md"] },
  { source: "src/workflows/software-change/implementation/prompts", destination: "workflows/software-change/implementation/prompts", files: ["noopCheck.md", "preamble.md", "repair.md", "sessionContext.md", "sessionHandoff.md", "task.md", "taskInstructions.md"] },
  { source: "src/workflows/software-change/review/prompts", destination: "workflows/software-change/review/prompts", files: ["findings.md", "fix.md", "synthesizeFindings.md", "testIntegrity.md"] },
  { source: "src/dashboard/public", destination: "dashboard/public", files: ["dashboard.css", "dashboard.js", "index.html"] },
];

type RootManifest = {
  name: string;
  version: string;
  description?: string;
  license: string;
  dependencies?: Record<string, string>;
  repository: { type: string; url: string };
  bugs: { url: string };
  homepage: string;
};

export function stagedManifest(root: RootManifest) {
  return {
    name: root.name,
    version: root.version,
    description: root.description,
    license: root.license,
    repository: root.repository,
    bugs: root.bugs,
    homepage: root.homepage,
    engines: { node: "*", bun: "*" },
    publishConfig: { access: "public", provenance: true },
    type: "module",
    types: "./src/index.d.ts",
    exports: {
      ".": {
        types: "./src/index.d.ts",
        import: "./src/index.js",
      },
      "./contracts": {
        types: "./src/contracts-entry.d.ts",
        import: "./src/contracts-entry.js",
      },
      "./server": {
        types: "./src/server-entry.d.ts",
        import: "./src/server-entry.js",
      },
    },
    bin: { sigil: "./src/cli.js" },
    files: ["build-metadata.json", "resources", "resources-manifest.json", "schemas", "src"],
    dependencies: root.dependencies ?? {},
  };
}

export function stagedFiles(root = stagingRoot): string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) files.push(relative(root, path));
    }
  }

  visit(root);
  return files.sort();
}

function emitTypeScript(): void {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", "tsconfig.build.json"],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("package TypeScript emit failed");
}

function copyRuntimeResources(): Array<{ path: string; digest: string }> {
  const resources: Array<{ path: string; digest: string }> = [];
  for (const group of RUNTIME_RESOURCE_GROUPS) {
    const actual = readdirSync(group.source).sort();
    const declared = [...group.files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) {
      throw new Error(`runtime resource inventory mismatch in ${group.source}`);
    }
    for (const name of group.files) {
      const source = join(group.source, name);
      const path = join("resources", group.destination, name);
      const destination = join(stagingRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
      resources.push({ path, digest: createHash("sha256").update(readFileSync(source)).digest("hex") });
    }
  }
  return resources.sort((left, right) => left.path.localeCompare(right.path));
}

function assertStagedEntrypoints(): void {
  for (const file of [
    "src/index.js",
    "src/index.d.ts",
    "src/contracts-entry.js",
    "src/contracts-entry.d.ts",
    "src/server-entry.js",
    "src/server-entry.d.ts",
    "src/cli.js",
    "src/cli.d.ts",
  ]) {
    if (!statSync(join(stagingRoot, file)).isFile()) throw new Error(`missing staged entrypoint: ${file}`);
  }
}

export function buildPackage(): string[] {
  const root = JSON.parse(readFileSync("package.json", "utf8")) as RootManifest;

  rmSync(stagingRoot, { recursive: true, force: true });
  emitTypeScript();
  const resources = copyRuntimeResources();
  mkdirSync(join(stagingRoot, "schemas"), { recursive: true });
  writeFileSync(
    join(stagingRoot, "schemas", "task-graph.schema.json"),
    `${JSON.stringify(taskGraphJsonSchema, null, 2)}\n`,
  );
  writeFileSync(join(stagingRoot, "resources-manifest.json"), `${JSON.stringify(resources, null, 2)}\n`);
  const manifest = `${JSON.stringify(stagedManifest(root), null, 2)}\n`;
  writeFileSync(join(stagingRoot, "package.json"), manifest);
  chmodSync(join(stagingRoot, "src", "cli.js"), 0o755);
  assertStagedEntrypoints();

  const files = stagedFiles();
  const manifestIdentity = createHash("sha256").update(manifest).digest("hex");
  const exportsIdentity = createHash("sha256")
    .update(JSON.stringify(stagedManifest(root).exports))
    .digest("hex");
  writeFileSync(
    join(stagingRoot, "build-metadata.json"),
    `${JSON.stringify({ files, manifestIdentity, exportsIdentity }, null, 2)}\n`,
  );
  return files;
}

if (import.meta.main) buildPackage();
