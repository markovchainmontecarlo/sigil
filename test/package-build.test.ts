import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

import { taskGraphJsonSchema } from "../src/contracts/task-graph.js";

const packageRoot = join(process.cwd(), "dist", "package");

function run(command: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function build(): string[] {
  const result = run(["bun", "run", "build"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(readFileSync(join(packageRoot, "build-metadata.json"), "utf8")).files;
}

describe("staged package build", () => {
  test("emits a deterministic publishable package", () => {
    const firstFiles = build();
    const firstMetadata = readFileSync(join(packageRoot, "build-metadata.json"), "utf8");
    const firstResources = readFileSync(join(packageRoot, "resources-manifest.json"), "utf8");
    const secondFiles = build();
    const secondMetadata = readFileSync(join(packageRoot, "build-metadata.json"), "utf8");
    const secondResources = readFileSync(join(packageRoot, "resources-manifest.json"), "utf8");
    const resources = JSON.parse(firstResources) as Array<{ path: string; digest: string }>;
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

    expect(secondFiles).toEqual(firstFiles);
    expect(secondMetadata).toBe(firstMetadata);
    expect(secondResources).toBe(firstResources);
    expect(resources.every((entry) => entry.path.startsWith("resources/") && /^[a-f0-9]{64}$/.test(entry.digest))).toBe(true);
    expect(resources.some((entry) => entry.path.endsWith("workflow.mermaid"))).toBe(false);
    expect(resources.some((entry) => entry.path === "resources/dashboard/public/index.html")).toBe(true);
    expect(firstFiles).toEqual([...firstFiles].sort());
    expect(firstFiles).toContain("src/index.js");
    expect(firstFiles).toContain("src/index.d.ts");
    expect(firstFiles).toContain("src/contracts-entry.js");
    expect(firstFiles).toContain("src/contracts-entry.d.ts");
    expect(firstFiles).toContain("src/server-entry.js");
    expect(firstFiles).toContain("src/server-entry.d.ts");
    expect(firstFiles).toContain("src/cli.js");
    expect(firstFiles).toContain("src/cli.d.ts");
    expect(firstFiles).toContain("schemas/task-graph.schema.json");
    expect(JSON.parse(readFileSync(join(packageRoot, "schemas", "task-graph.schema.json"), "utf8"))).toEqual(taskGraphJsonSchema);
    expect(firstFiles.some((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))).toBe(false);
    expect(firstFiles.some((file) => file.startsWith("test/") || file.startsWith("examples/"))).toBe(false);
    expect(manifest.private).toBeUndefined();
    expect(manifest.types).toBe("./src/index.d.ts");
    expect(manifest.exports).toEqual({
      ".": { types: "./src/index.d.ts", import: "./src/index.js" },
      "./contracts": {
        types: "./src/contracts-entry.d.ts",
        import: "./src/contracts-entry.js",
      },
      "./server": {
        types: "./src/server-entry.d.ts",
        import: "./src/server-entry.js",
      },
    });
    expect(manifest.files).toEqual(["build-metadata.json", "resources", "resources-manifest.json", "schemas", "src"]);
    expect(manifest.bin).toEqual({ sigil: "./src/cli.js" });
    expect(statSync(join(packageRoot, "src", "cli.js")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync("package.json", "utf8")).private).toBe(true);

    const validation = run(["bun", "pm", "pack", "--dry-run"], packageRoot);
    expect(validation.exitCode, validation.stderr.toString()).toBe(0);
  }, 30_000);

  test("runs with Bun, loads installed resources, and stays inert when imported", async () => {
    build();
    const help = run(["bun", "src/cli.js", "--help"], packageRoot);
    const imported = run(["bun", "-e", "await import('./src/cli.js'); console.log('imported')"], packageRoot);

    expect(help.exitCode, help.stderr.toString()).toBe(0);
    expect(help.stdout.toString()).toContain("Usage:");
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    expect(imported.stdout.toString()).toBe("imported\n");
    expect(imported.stderr.toString()).toBe("");

    const prompts = await import(pathToFileURL(join(packageRoot, "src", "prompts.js")).href);
    const resources = JSON.parse(readFileSync(join(packageRoot, "resources-manifest.json"), "utf8")) as Array<{ path: string }>;
    for (const resource of resources.filter((entry) => entry.path.endsWith(".md"))) {
      expect(prompts.loadPromptTemplate(resource.path.slice("resources/".length))).toBeString();
    }

    const dashboardModule = await import(pathToFileURL(join(packageRoot, "src", "dashboard", "server.js")).href);
    const dashboard = dashboardModule.startDashboardServer({ host: "127.0.0.1", port: 0, roots: [] });
    try {
      for (const asset of ["/", "/dashboard.js", "/dashboard.css"]) {
        expect((await fetch(`${dashboard.url}${asset}`)).status).toBe(200);
      }
    } finally {
      dashboard.stop();
    }
  }, 30_000);

});
