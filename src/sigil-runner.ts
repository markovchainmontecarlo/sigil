import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createContext, type SigilContext } from "./context.js";
import { readProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import { assertDurablePaths, type RunPersistence } from "./storage.js";

export type TypeScriptSigil = (input: Record<string, unknown>, ctxOverride?: SigilContext) => Promise<unknown>;
export type RunSigilInput = {
  repo: string;
  file: string;
  inputFile?: string;
  outFile?: string;
  runDir?: string;
  persistence?: RunPersistence;
  onObserve?: (stage: string, details: Record<string, string>) => Promise<void>;
};
export type RunSigilResult = {
  result: unknown;
  formatted: string;
  outFile?: string;
};
export type ValidateSigilResult = {
  valid: boolean;
  errors: string[];
};

export type RunSigilManifest = {
  repo: string;
  file: string;
  inputFile?: string;
  outFile?: string;
  runDir: string;
  persistence: RunPersistence;
};

export type RunSigilHandle = {
  state: "started";
  pid: number;
  runDir: string;
  artifactDir: string;
  manifestFile: string;
  pidFile: string;
  statusFile: string;
  eventsFile: string;
  logFile: string;
  resultFile: string;
  errorFile: string;
};

type RunSigilStatus = {
  state: "starting" | "started" | "running" | "succeeded" | "failed";
  pid?: number;
  processIdentity?: ProcessIdentity;
  message: string;
  updatedAt: string;
};

type RunLayout = Omit<RunSigilHandle, "state" | "pid">;

type ResolvedRunStorage = {
  repo: string;
  file: string;
  inputFile?: string;
  outFile?: string;
  runDir: string;
  persistence: RunPersistence;
};

export class SigilRunnerError extends Error {
  constructor(
    readonly code: "missing-file" | "import-failure" | "missing-export" | "invalid-input-json" | "unsafe-storage" | "workflow-exception",
    message: string,
  ) {
    super(message);
    this.name = "SigilRunnerError";
  }
}

export async function runTypeScriptSigil(input: RunSigilInput): Promise<RunSigilResult> {
  const repo = resolve(input.repo);
  const file = resolve(input.file);
  const workflowInput = await loadWorkflowInput(repo, input.inputFile);
  const artifactRoot = await prepareArtifactRoot(input.runDir);
  const workflow = await loadTypeScriptSigil(file);
  const ctx = createContext(repo, {
    ...(artifactRoot ? { artifactRoot } : {}),
    onObserve: input.onObserve,
  });
  await ctx.initialize();
  const result = await callWorkflow(workflow, workflowInput, ctx);
  const formatted = `${JSON.stringify(result, null, 2)}\n`;
  const outFile = await writeResult(input.outFile, formatted);

  return { result, formatted, outFile };
}

export async function launchTypeScriptSigil(input: RunSigilInput): Promise<RunSigilHandle> {
  const manifest = await prepareManifest(input);
  const layout = runLayout(manifest.runDir);

  await initializeRun(layout, manifest);
  const descriptor = openSync(layout.logFile, "a");
  const cli = siblingModule("cli");
  const child = spawn(process.execPath, [cli, "__run-sigil-worker", "--manifest", layout.manifestFile], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
    env: process.env,
  });
  closeSync(descriptor);
  child.unref();

  if (!child.pid) throw new Error("detached Sigil worker did not return a PID");
  await writeFile(layout.pidFile, `${child.pid}\n`);
  await writeRunStatus(layout, { state: "started", pid: child.pid, message: "detached worker started" });
  await recordRunEvent(layout, "worker-started", { pid: String(child.pid) });
  return { ...layout, state: "started", pid: child.pid };
}

export async function runTypeScriptSigilWorker(manifestFile: string): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(manifestFile), "utf8")) as RunSigilManifest;
  const layout = runLayout(manifest.runDir);
  const processIdentity = await readProcessIdentity();
  await writeRunStatus(layout, { state: "running", pid: process.pid, processIdentity, message: "workflow running" });
  await recordRunEvent(layout, "workflow-started", { pid: String(process.pid) });

  try {
    const result = await runTypeScriptSigil({
      ...manifest,
      onObserve: (stage, details) => recordRunEvent(layout, stage, details),
    });
    await writeFile(layout.resultFile, result.formatted);
    await writeRunStatus(layout, { state: "succeeded", pid: process.pid, processIdentity, message: "workflow succeeded" });
    await recordRunEvent(layout, "workflow-succeeded");
  } catch (error) {
    const message = errorMessage(error);
    await writeFile(layout.errorFile, `${message}\n`);
    await writeRunStatus(layout, { state: "failed", pid: process.pid, processIdentity, message });
    await recordRunEvent(layout, "workflow-failed", { error: message });
    throw error;
  }
}

export async function validateTypeScriptSigil(file: string): Promise<ValidateSigilResult> {
  try {
    await loadTypeScriptSigil(resolve(file));
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [validationErrorMessage(error)] };
  }
}

export async function loadTypeScriptSigil(file: string): Promise<TypeScriptSigil> {
  await assertWorkflowFileExists(file);

  const module = await importWorkflowModule(file);
  const workflow = resolveWorkflowExport(module);
  if (workflow) return workflow;

  throw new SigilRunnerError(
    "missing-export",
    `missing callable workflow export in ${file}; export default a sigil or export const workflow = ...`,
  );
}

async function loadWorkflowInput(repo: string, inputFile?: string): Promise<Record<string, unknown>> {
  const loaded = inputFile ? await readInputFile(inputFile) : {};
  return { ...loaded, repo };
}

async function readInputFile(inputFile: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(inputFile, "utf8"));
    if (isRecord(parsed)) return parsed;
    throw new Error("input JSON must be an object");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SigilRunnerError("invalid-input-json", `invalid input JSON ${inputFile}: ${message}`);
  }
}

async function prepareArtifactRoot(runDir?: string): Promise<string | undefined> {
  if (!runDir) return undefined;

  const dir = resolve(runDir);
  const artifactRoot = join(dir, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  return artifactRoot;
}

async function prepareManifest(input: RunSigilInput): Promise<RunSigilManifest> {
  const repo = resolve(input.repo);
  const file = resolve(input.file);
  const inputFile = input.inputFile ? resolve(input.inputFile) : undefined;
  const outFile = input.outFile ? resolve(input.outFile) : undefined;
  const persistence = input.persistence ?? "durable";
  await assertWorkflowFileExists(file);
  if (inputFile) await readInputFile(inputFile);
  const runDir = input.runDir
    ? resolve(input.runDir)
    : await defaultRunDirectory(repo, persistence);
  assertRunStorage({ repo, file, inputFile, outFile, runDir, persistence });
  return {
    repo,
    file,
    inputFile,
    outFile,
    runDir,
    persistence,
  };
}

async function defaultRunDirectory(repo: string, persistence: RunPersistence): Promise<string> {
  const root = persistence === "durable"
    ? join(repo, ".sigil", "runs")
    : join(tmpdir(), "sigil-runs");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "run-"));
}

function assertRunStorage(input: ResolvedRunStorage): void {
  if (input.persistence === "ephemeral") return;

  try {
    assertDurablePaths([
      { label: "target repository", path: input.repo },
      { label: "workflow file", path: input.file },
      { label: "run directory", path: input.runDir },
      ...(input.inputFile ? [{ label: "input file", path: input.inputFile }] : []),
      ...(input.outFile ? [{ label: "output file", path: input.outFile }] : []),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SigilRunnerError("unsafe-storage", message);
  }
}

function runLayout(runDir: string): RunLayout {
  return {
    runDir,
    artifactDir: join(runDir, "artifacts"),
    manifestFile: join(runDir, "manifest.json"),
    pidFile: join(runDir, "run.pid"),
    statusFile: join(runDir, "status.json"),
    eventsFile: join(runDir, "events.jsonl"),
    logFile: join(runDir, "run.log"),
    resultFile: join(runDir, "result.json"),
    errorFile: join(runDir, "error.txt"),
  };
}

async function initializeRun(layout: RunLayout, manifest: RunSigilManifest): Promise<void> {
  await mkdir(layout.artifactDir, { recursive: true });
  await writeFile(layout.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(layout.eventsFile, "");
  await writeFile(layout.logFile, "");
  await writeFile(layout.resultFile, "");
  await writeFile(layout.errorFile, "");
  await writeRunStatus(layout, { state: "starting", message: "launching detached worker" });
}

async function writeRunStatus(layout: RunLayout, status: Omit<RunSigilStatus, "updatedAt">): Promise<void> {
  const value: RunSigilStatus = { ...status, updatedAt: new Date().toISOString() };
  const temporary = `${layout.statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, layout.statusFile);
}

async function recordRunEvent(layout: RunLayout, stage: string, details: Record<string, string> = {}): Promise<void> {
  const event = { at: new Date().toISOString(), stage, ...details };
  await appendFile(layout.eventsFile, `${JSON.stringify(event)}\n`);
  await appendFile(layout.logFile, `[${event.at}] ${stage}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}\n`);
}

async function assertWorkflowFileExists(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new SigilRunnerError("missing-file", `workflow file not found: ${file}`);
  }
}

function sigilImportPlugin(): Bun.BunPlugin {
  const publicEntrypoint = siblingModule("index");
  return {
    name: "sigil-runner-imports",
    setup(build) {
      build.onResolve({ filter: /^sigil$/ }, () => ({
        path: publicEntrypoint,
        external: true,
      }));
    },
  };
}

async function importWorkflowModule(file: string): Promise<Record<string, unknown>> {
  try {
    const bundled = await bundleWorkflow(file);
    return await import(bundled) as Record<string, unknown>;
  } catch (error) {
    throw new SigilRunnerError(
      "import-failure",
      `workflow import failed for ${file}: ${errorMessage(error)}`,
    );
  }
}

async function bundleWorkflow(file: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [file],
    format: "esm",
    target: "bun",
    plugins: [sigilImportPlugin()],
  });

  if (!built.success) {
    const logs = built.logs.map((log) => `${log.name}: ${log.message}`).join("; ");
    throw new Error(logs || "bundle failed");
  }

  const output = built.outputs.find((artifact) => artifact.kind === "entry-point");
  if (!output) throw new Error("bundle did not produce an entry point");

  const dir = await mkdtemp(join(tmpdir(), "sigil-runner-bundle-"));
  const fileName = join(dir, "workflow.mjs");
  const publicEntrypoint = pathToFileURL(siblingModule("index")).href;
  const source = (await output.text()).replaceAll('"sigil"', JSON.stringify(publicEntrypoint));
  await writeFile(fileName, source);
  return pathToFileURL(fileName).href;
}

function siblingModule(name: string): string {
  const extension = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`./${name}${extension}`, import.meta.url));
}

function resolveWorkflowExport(module: Record<string, unknown>): TypeScriptSigil | undefined {
  if (typeof module.default === "function") return module.default as TypeScriptSigil;
  if (typeof module.workflow === "function") return module.workflow as TypeScriptSigil;
  return undefined;
}

async function callWorkflow(workflow: TypeScriptSigil, input: Record<string, unknown>, ctx: SigilContext): Promise<unknown> {
  try {
    return await workflow(input, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SigilRunnerError("workflow-exception", `workflow failed: ${message}`);
  }
}

async function writeResult(outFile: string | undefined, formatted: string): Promise<string | undefined> {
  if (!outFile) return undefined;

  const file = resolve(outFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, formatted);
  return file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationErrorMessage(error: unknown): string {
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
