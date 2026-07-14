#!/usr/bin/env bun
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: test-package-consumers.ts <tarball>");

const root = mkdtempSync("/tmp/sigil-package-consumers-");
const nodeApp = join(root, "node-app");
const browserApp = join(root, "browser-app");
installDependencies(root);
cpSync("test/fixtures/node-app", nodeApp, { recursive: true });
cpSync("test/fixtures/browser-app", browserApp, { recursive: true });
prepareManifest(nodeApp);
prepareManifest(browserApp);

run("node fixture compile", [join(root, "node_modules", ".bin", "tsc"), "-p", "tsconfig.json"], nodeApp);
const nodeReport = join(root, "node-report.json");
run("node worker", ["node", "dist/main.js", nodeReport], nodeApp);

const examples = join(root, "examples");
cpSync("examples", examples, { recursive: true });
writeFileSync(join(examples, "package.json"), JSON.stringify({
  type: "module",
}));
writeFileSync(join(examples, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2022", "ESNext.Disposable"],
    types: ["node"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
}));
run("examples compile", [join(root, "node_modules", ".bin", "tsc"), "-p", "tsconfig.json"], examples);

run("browser contracts", ["bun", "build", "src/contracts.ts", "--target=browser", "--outdir=dist/contracts"], browserApp);
expectRejected("browser root", ["bun", "build", "src/root.ts", "--target=browser", "--outdir=dist/root"], browserApp);
expectRejected("browser server", ["bun", "build", "src/server.ts", "--target=browser", "--outdir=dist/server"], browserApp);

const reportPath = join(root, "report.json");
const node = JSON.parse(readFileSync(nodeReport, "utf8"));
writeFileSync(reportPath, JSON.stringify({
  node: { ...node, sourceIsolated: true },
  examples: { compiled: true },
  browser: { contracts: "accepted", root: "rejected", server: "rejected" },
}));
console.log(reportPath);

function installDependencies(directory: string): void {
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      sigil: tarball,
      zod: "^4.0.0",
      typescript: "^5.9.3",
      "@types/node": "^24.10.1",
    },
  }));
  run("consumer dependencies install", ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
}

function prepareManifest(directory: string): void {
  const manifestPath = join(directory, "package.json");
  const manifest = readFileSync(manifestPath, "utf8").replace("SIGIL_TARBALL", tarball);
  writeFileSync(manifestPath, manifest);
}

function run(phase: string, command: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return;
  throw new Error(`${phase} failed\n${result.stdout}\n${result.stderr}`);
}

function expectRejected(phase: string, command: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && result.stderr.toString().includes("Browser build cannot import Node.js builtin")) return;
  throw new Error(`${phase} did not reject the server-only dependency graph\n${result.stdout}\n${result.stderr}`);
}
