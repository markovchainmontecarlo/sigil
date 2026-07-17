import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import {
  processIdentityIsAlive,
  readProcessGroupId,
  readProcessIdentity,
  signalProcessGroup,
  type ProcessIdentity,
} from "./process-identity.js";
import { terminateProcessGroup } from "./process-group.js";
import type {
  OwnedProcessInfo,
  OwnedProcessKind,
  ProcessLifecycle,
} from "./process-lifecycle.js";

export type { OwnedProcessInfo, OwnedProcessKind, ProcessLifecycle } from "./process-lifecycle.js";

export type OwnedProcessOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  kind: OwnedProcessKind;
  signal?: AbortSignal;
  lifecycle?: ProcessLifecycle;
  terminationTimeoutMs?: number;
  maxBufferBytes?: number;
};

export type OwnedProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type ProcessObservation = {
  stdout: string;
  stderr: string;
  terminated: Promise<void>;
  exited: Promise<OwnedProcessResult>;
};

const DEFAULT_TERMINATION_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export class OwnedProcess implements AsyncDisposable {
  readonly child: ChildProcessWithoutNullStreams;
  readonly identity: ProcessIdentity;
  readonly info: OwnedProcessInfo;

  private readonly exited: Promise<OwnedProcessResult>;
  private cleanup?: Promise<void>;
  private stopped = false;
  private readonly ownsProcessGroup: boolean;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    identity: ProcessIdentity,
    private readonly options: OwnedProcessOptions,
    ownsProcessGroup: boolean,
    private readonly observation: ProcessObservation,
  ) {
    this.child = child;
    this.identity = identity;
    this.ownsProcessGroup = ownsProcessGroup;
    this.info = {
      identity,
      ownerIdentity: { pid: process.pid, startIdentity: "" },
      kind: options.kind,
      processGroupId: identity.pid,
    };
    this.exited = observation.exited;
  }

  static async spawn(options: OwnedProcessOptions): Promise<OwnedProcess> {
    const child = spawn(options.command, options.args ?? [], spawnOptions(options));
    return this.initialize(child, options, process.platform !== "win32");
  }

  static async adopt(
    child: ChildProcessWithoutNullStreams,
    options: Omit<OwnedProcessOptions, "command" | "args">,
  ): Promise<OwnedProcess> {
    return this.initialize(child, { ...options, command: "injected-child" });
  }

  private static async initialize(
    child: ChildProcessWithoutNullStreams,
    options: OwnedProcessOptions,
    ownsProcessGroup?: boolean,
  ): Promise<OwnedProcess> {
    if (!child.pid) throw new Error(`failed to start ${options.kind} process`);
    const observation = observeChild(child, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
    let owner: OwnedProcess | undefined;
    try {
      const identity = await readSpawnedProcessIdentity(child.pid, observation);
      const processGroupId = ownsProcessGroup === undefined
        ? await injectedProcessGroupId(child.pid)
        : child.pid;
      const ownsGroup = ownsProcessGroup ?? processGroupId === child.pid;
      owner = new OwnedProcess(child, identity, options, ownsGroup, observation);
      owner.info.processGroupId = processGroupId;
      owner.info.ownerIdentity = await readProcessIdentity();
      await options.lifecycle?.started?.(owner.info);
      options.signal?.addEventListener("abort", owner.abort, { once: true });
      if (options.signal?.aborted) await owner.dispose();
      return owner;
    } catch (error) {
      if (owner) await owner.dispose();
      else child.kill("SIGKILL");
      throw error;
    }
  }

  get capturedStderr(): string {
    return this.observation.stderr;
  }

  async wait(): Promise<OwnedProcessResult> {
    const result = await this.exited;
    await this.disposeAfterExit();
    return result;
  }

  async dispose(): Promise<void> {
    this.cleanup ??= this.stop();
    await this.cleanup;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private readonly abort = (): void => {
    void this.dispose();
  };

  private async stop(): Promise<void> {
    this.options.signal?.removeEventListener("abort", this.abort);
    if (this.ownsProcessGroup) {
      await this.terminateGroup();
      await this.publishStopped();
      return;
    }
    if (await processIdentityIsAlive(this.identity)) this.signal("SIGTERM");
    if (!(await this.groupGoneWithin(this.timeoutMs))) this.signal("SIGKILL");
    await this.confirmGone();
    await this.publishStopped();
  }

  private async disposeAfterExit(): Promise<void> {
    this.cleanup ??= this.cleanDescendantsAfterExit();
    await this.cleanup;
  }

  private async cleanDescendantsAfterExit(): Promise<void> {
    this.options.signal?.removeEventListener("abort", this.abort);
    if (this.ownsProcessGroup) {
      await this.terminateGroup();
      await this.publishStopped();
      return;
    }
    if (this.groupIsAlive()) this.signal("SIGTERM");
    if (!(await this.groupGoneWithin(this.timeoutMs))) this.signal("SIGKILL");
    await this.confirmGone();
    await this.publishStopped();
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.ownsProcessGroup && signalProcessGroup(this.info.processGroupId, signal)) return;
    try {
      this.child.kill(signal);
    } catch {
      return;
    }
  }

  private groupIsAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private async terminateGroup(): Promise<void> {
    await terminateProcessGroup({
      identity: this.identity,
      processGroupId: this.info.processGroupId,
      terminationGraceMs: this.timeoutMs,
      killGraceMs: this.timeoutMs,
    });
  }

  private async groupGoneWithin(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (this.groupIsAlive() && Date.now() < deadline) await delay(20);
    return !this.groupIsAlive();
  }

  private async confirmGone(): Promise<void> {
    while (this.groupIsAlive()) await delay(20);
  }

  private async publishStopped(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.options.lifecycle?.stopped?.(this.info);
  }

  private get timeoutMs(): number {
    return this.options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
  }
}

function spawnOptions(options: OwnedProcessOptions): SpawnOptionsWithoutStdio & {
  stdio: ["pipe", "pipe", "pipe"];
} {
  return {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  };
}

function observeChild(
  child: ChildProcessWithoutNullStreams,
  limit: number,
): ProcessObservation {
  const observation = {} as ProcessObservation;
  observation.stdout = "";
  observation.stderr = "";

  child.stdout.on("data", (chunk) => {
    observation.stdout = appendWithin(observation.stdout, chunk, limit);
  });
  child.stderr.on("data", (chunk) => {
    observation.stderr = appendWithin(observation.stderr, chunk, limit);
  });
  observation.terminated = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  observation.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      stdout: observation.stdout,
      stderr: observation.stderr,
      exitCode,
      signal,
    }));
  });
  return observation;
}

async function readSpawnedProcessIdentity(
  pid: number,
  observation: ProcessObservation,
): Promise<ProcessIdentity> {
  try {
    return await readProcessIdentity(pid);
  } catch (error) {
    if ((error as { code?: string | number }).code !== 1) throw error;
  }

  await observation.terminated;
  return { pid, startIdentity: "exited-before-identity-read" };
}

function appendWithin(current: string, chunk: unknown, limit: number): string {
  const next = current + String(chunk);
  return Buffer.byteLength(next) <= limit ? next : next.slice(-limit);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function injectedProcessGroupId(pid: number): Promise<number> {
  return readProcessGroupId(pid);
}
