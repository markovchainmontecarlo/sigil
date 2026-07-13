#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
if (process.argv[2] === "--check-record") {
  checkVerificationRecord(resolve(process.argv[3] ?? ""));
  process.exit(0);
}
const dist = join(root, "dist", "verified-package");
const temporary = mkdtempSync(join(tmpdir(), "sigil-package-verification-"));
const packageManifest = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
const registry = join(dist, `${packageManifest.name}-${packageManifest.version}-registry.tgz`);
const installer = join(dist, `${packageManifest.name}-${packageManifest.version}-installer.tgz`);
const recordPath = join(dist, "verification.json");

run("build", ["bun", "run", "build"]);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const registryRoot = join(temporary, "registry");
cpSync("dist/package", registryRoot, { recursive: true });
cpSync("LICENSE", join(registryRoot, "LICENSE"));
cpSync("README.md", join(registryRoot, "README.md"));
run("registry archive", ["npm", "pack", "--ignore-scripts", "--pack-destination", dist, "--json"], registryRoot);
const npmArchive = join(dist, `${packageManifest.name}-${packageManifest.version}.tgz`);
if (!existsSync(npmArchive)) throw new Error("registry archive was not produced");
rmSync(registry, { force: true });
cpSync(npmArchive, registry);
rmSync(npmArchive);

const installerRoot = join(temporary, "installer", "package");
mkdirSync(join(temporary, "installer"), { recursive: true });
run("seed installer", ["tar", "-xzf", registry, "-C", join(temporary, "installer")]);
for (const path of ["skills", "docs", "man"]) cpSync(path, join(installerRoot, path), { recursive: true });
for (const path of ["ARCHITECTURE.md", "SIGIL_USAGE.md"]) cpSync(path, join(installerRoot, path));
run("installer lockfile", ["bun", "install", "--lockfile-only", "--ignore-scripts"], installerRoot);
run("installer archive", ["tar", "-czf", installer, "-C", join(temporary, "installer"), "package"]);
writeFileSync(`${installer}.sha256`, `${digest(installer)}  ${installer.split("/").at(-1)}\n`);

const shared = files(registryRoot);
assertInventory(registry, shared);
assertInstallerInventory(installer, files(installerRoot));
assertSharedBytes(registry, installer, shared);

run("package consumers", ["bun", "scripts/test-package-consumers.ts", registry]);
run("installer smoke", ["bash", "scripts/distribution-smoke.sh", installer, `${installer}.sha256`]);

const buildIdentity = digest(join("dist/package", "build-metadata.json"));
const resourceIdentity = digest(join("dist/package", "resources-manifest.json"));
const stagedBuild = JSON.parse(readFileSync(join("dist/package", "build-metadata.json"), "utf8")) as {
  manifestIdentity: string;
  exportsIdentity: string;
};
const record = {
  version: 1,
  manifests: {
    package: stagedBuild.manifestIdentity,
    exports: stagedBuild.exportsIdentity,
    build: buildIdentity,
    resources: resourceIdentity,
  },
  artifacts: {
    registry: { path: relative(root, registry), digest: digest(registry) },
    installer: { path: relative(root, installer), digest: digest(installer) },
  },
  checks: {
    inventory: "passed",
    sharedBytes: "passed",
    packageConsumers: "passed",
    installerSmoke: "passed",
  },
};
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ verification: relative(root, recordPath), ...record }));

function run(name: string, command: string[], cwd = root): void {
  const result = Bun.spawnSync({ cmd: command, cwd, env: { ...process.env, TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0) return;
  throw new Error(`${name} failed\n${result.stdout}\n${result.stderr}`);
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(directory: string): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) output.push(relative(directory, path));
    }
  };
  visit(directory);
  return output.sort();
}

function archiveFiles(archive: string): string[] {
  const result = Bun.spawnSync({ cmd: ["tar", "-tzf", archive], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`cannot inspect ${archive}`);
  return result.stdout.toString().trim().split("\n").filter((path) => path && !path.endsWith("/"));
}

function assertInventory(archive: string, expected: string[]): void {
  const actual = archiveFiles(archive).map((path) => path.replace(/^package\//, "")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("registry inventory differs from its explicit staging manifest");
  if (actual.some((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))) throw new Error("registry contains TypeScript source");
  if (actual.some((path) => path.startsWith("test/") || path.includes(".sigil/") || path.endsWith(".mermaid"))) throw new Error("registry contains undeclared private or documentation material");
}

function assertInstallerInventory(archive: string, expected: string[]): void {
  const actual = archiveFiles(archive).map((path) => path.replace(/^package\//, "")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("installer inventory differs from its explicit staging manifest");
}

function assertSharedBytes(registryArchive: string, installerArchive: string, expected: string[]): void {
  const registryExtract = join(temporary, "registry-extract");
  const installerExtract = join(temporary, "installer-extract");
  mkdirSync(registryExtract); mkdirSync(installerExtract);
  run("extract registry", ["tar", "-xzf", registryArchive, "-C", registryExtract]);
  run("extract installer", ["tar", "-xzf", installerArchive, "-C", installerExtract]);
  for (const path of expected) {
    const left = join(registryExtract, "package", path);
    const right = join(installerExtract, "package", path);
    if (!statSync(left).isFile() || digest(left) !== digest(right)) throw new Error(`shared artifact byte mismatch: ${path}`);
  }
}

function checkVerificationRecord(path: string): void {
  if (!path || !existsSync(path)) throw new Error("verification record is missing");
  const record = JSON.parse(readFileSync(path, "utf8")) as {
    manifests?: { package?: string; exports?: string; build?: string; resources?: string };
    artifacts?: { registry?: { path?: string; digest?: string }; installer?: { path?: string; digest?: string } };
    checks?: Record<string, string>;
  };
  const requiredChecks = ["inventory", "sharedBytes", "packageConsumers", "installerSmoke"];
  if (!record.checks || requiredChecks.some((name) => record.checks?.[name] !== "passed")) {
    throw new Error("verification record does not contain every passed publication check");
  }
  const registryPath = resolve(record.artifacts?.registry?.path ?? "");
  const installerPath = resolve(record.artifacts?.installer?.path ?? "");
  if (!existsSync(registryPath) || digest(registryPath) !== record.artifacts?.registry?.digest) {
    throw new Error("verified registry artifact is missing or recomposed");
  }
  if (!existsSync(installerPath) || digest(installerPath) !== record.artifacts?.installer?.digest) {
    throw new Error("verified installer artifact is missing or recomposed");
  }

  const checkRoot = mkdtempSync(join(tmpdir(), "sigil-publication-record-"));
  run("extract publication artifact", ["tar", "-xzf", registryPath, "-C", checkRoot]);
  const packageRoot = join(checkRoot, "package");
  const manifest = readFileSync(join(packageRoot, "package.json"));
  const build = readFileSync(join(packageRoot, "build-metadata.json"));
  const resources = join(packageRoot, "resources-manifest.json");
  const parsedManifest = JSON.parse(manifest.toString()) as { exports: unknown };
  if (createHash("sha256").update(manifest).digest("hex") !== record.manifests?.package) {
    throw new Error("verified package manifest identity does not match the registry artifact");
  }
  if (createHash("sha256").update(JSON.stringify(parsedManifest.exports)).digest("hex") !== record.manifests?.exports) {
    throw new Error("verified export identity does not match the registry artifact");
  }
  if (createHash("sha256").update(build).digest("hex") !== record.manifests?.build) {
    throw new Error("verified build identity does not match the registry artifact");
  }
  if (digest(resources) !== record.manifests?.resources) {
    throw new Error("verified resource identity does not match the registry artifact");
  }
}
