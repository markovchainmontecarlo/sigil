import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandName } from "./help.js";
import { readProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import { assertDurablePaths } from "./storage.js";

export const detachedCommandNames = new Set<CommandName>([
  "migrate",
  "refactor",
  "probe",
  "plan",
  "software-change",
  "implement",
  "review",
  "breakdown",
  "dispatch",
  "run-workflow",
]);

export type DetachedCommandHandle = {
  state: "started";
  pid: number;
  runDir: string;
  manifestFile: string;
  pidFile: string;
  statusFile: string;
  eventsFile: string;
  logFile: string;
  resultFile: string;
  errorFile: string;
};

type CommandManifest = {
  command: CommandName;
  args: string[];
  runDir: string;
};

type CommandStatus = {
  state: "starting" | "started" | "running" | "succeeded" | "failed";
  pid?: number;
  processIdentity?: ProcessIdentity;
  exitCode?: number;
  message: string;
  updatedAt: string;
};

type CommandLayout = Omit<DetachedCommandHandle, "state" | "pid">;

export function requestsForeground(args: string[]): boolean {
  return args.includes("--foreground");
}

export function withoutForeground(args: string[]): string[] {
  return args.filter((arg) => arg !== "--foreground");
}

export async function launchDetachedCommand(
  command: CommandName,
  args: string[],
): Promise<DetachedCommandHandle> {
  const root = commandRunRoot(args, process.cwd());
  const runDir = await createRunDirectory(root, command);
  const manifest = { command, args, runDir } satisfies CommandManifest;
  const layout = commandLayout(runDir);

  await initializeCommandRun(layout, manifest);
  const child = spawnCommandWorker(layout);
  await recordStartedProcess(layout, child.pid);

  return { ...layout, state: "started", pid: child.pid };
}

export async function runDetachedCommandWorker(
  manifestFile: string,
  execute: (command: CommandName, args: string[]) => Promise<number>,
): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(manifestFile), "utf8")) as CommandManifest;
  const layout = commandLayout(manifest.runDir);
  const processIdentity = await readProcessIdentity();

  await recordRunningProcess(layout, processIdentity);

  try {
    const exitCode = await execute(manifest.command, manifest.args);
    await recordCommandResult(layout, processIdentity, exitCode);
  } catch (error) {
    await recordCommandFailure(layout, processIdentity, error);
    throw error;
  }
}

function commandRunRoot(args: string[], cwd: string): string {
  const repo = optionValue(args, "--repo") ?? cwd;
  assertDurablePaths([{ label: "target repository", path: repo }]);
  return join(resolve(repo), ".sigil", "runs");
}

async function createRunDirectory(root: string, command: CommandName): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${command}-`));
}

function spawnCommandWorker(layout: CommandLayout) {
  const descriptor = openSync(layout.logFile, "a");
  const child = spawn(
    process.execPath,
    [siblingModule("cli"), "__run-command-worker", "--manifest", layout.manifestFile],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: process.env,
    },
  );
  closeSync(descriptor);
  child.unref();
  if (!child.pid) throw new Error("detached command worker did not return a PID");
  return { pid: child.pid };
}

async function recordStartedProcess(layout: CommandLayout, pid: number): Promise<void> {
  await writeFile(layout.pidFile, `${pid}\n`);
  await writeCommandStatus(layout, { state: "started", pid, message: "detached command worker started" });
  await recordCommandEvent(layout, "worker-started", { pid: String(pid) });
}

async function recordRunningProcess(layout: CommandLayout, processIdentity: ProcessIdentity): Promise<void> {
  await writeCommandStatus(layout, {
    state: "running",
    pid: process.pid,
    processIdentity,
    message: "command running",
  });
  await recordCommandEvent(layout, "command-started", { pid: String(process.pid) });
}

async function recordCommandResult(
  layout: CommandLayout,
  processIdentity: ProcessIdentity,
  exitCode: number,
): Promise<void> {
  await writeFile(layout.resultFile, `${JSON.stringify({ exitCode }, null, 2)}\n`);
  const state = exitCode === 0 ? "succeeded" : "failed";
  const message = exitCode === 0 ? "command succeeded" : `command exited with code ${exitCode}`;
  await writeCommandStatus(layout, { state, pid: process.pid, processIdentity, exitCode, message });
  await recordCommandEvent(layout, `command-${state}`, { exitCode: String(exitCode) });
}

async function recordCommandFailure(
  layout: CommandLayout,
  processIdentity: ProcessIdentity,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(layout.errorFile, `${message}\n`);
  await writeCommandStatus(layout, {
    state: "failed",
    pid: process.pid,
    processIdentity,
    exitCode: 1,
    message,
  });
  await recordCommandEvent(layout, "command-failed", { error: message });
}

function commandLayout(runDir: string): CommandLayout {
  return {
    runDir,
    manifestFile: join(runDir, "manifest.json"),
    pidFile: join(runDir, "run.pid"),
    statusFile: join(runDir, "status.json"),
    eventsFile: join(runDir, "events.jsonl"),
    logFile: join(runDir, "run.log"),
    resultFile: join(runDir, "result.json"),
    errorFile: join(runDir, "error.txt"),
  };
}

async function initializeCommandRun(layout: CommandLayout, manifest: CommandManifest): Promise<void> {
  await mkdir(layout.runDir, { recursive: true });
  await writeFile(layout.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(layout.eventsFile, "");
  await writeFile(layout.logFile, "");
  await writeFile(layout.resultFile, "");
  await writeFile(layout.errorFile, "");
  await writeCommandStatus(layout, { state: "starting", message: "launching detached command worker" });
}

async function writeCommandStatus(
  layout: CommandLayout,
  status: Omit<CommandStatus, "updatedAt">,
): Promise<void> {
  const value: CommandStatus = { ...status, updatedAt: new Date().toISOString() };
  const temporary = `${layout.statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, layout.statusFile);
}

async function recordCommandEvent(
  layout: CommandLayout,
  stage: string,
  details: Record<string, string> = {},
): Promise<void> {
  const event = { at: new Date().toISOString(), stage, ...details };
  await appendFile(layout.eventsFile, `${JSON.stringify(event)}\n`);
  await appendFile(layout.logFile, `[${event.at}] ${stage}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}\n`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function siblingModule(name: string): string {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${extension}`, import.meta.url));
}
