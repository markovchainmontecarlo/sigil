import {
  readProcessGroupId,
  readProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.js";
import { terminateProcessGroup } from "./process-group.js";
import type { OwnedProcessInfo, ProcessLifecycle } from "./process-lifecycle.js";

export type PtyTerminal = Pick<Bun.Terminal, "write" | "close">;

export type PtySubprocess = Pick<Bun.Subprocess, "pid" | "exited" | "kill"> & {
  terminal: PtyTerminal | undefined;
};

export type SpawnPtyOptions = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  terminal: {
    cols?: number;
    rows?: number;
    name?: string;
    data(terminal: PtyTerminal, data: Uint8Array): void;
  };
};

export type SpawnPty = (options: SpawnPtyOptions) => PtySubprocess;

export type OwnedPtyProcessOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  name?: string;
  signal?: AbortSignal;
  lifecycle?: ProcessLifecycle;
  terminationTimeoutMs?: number;
  onData?(data: Uint8Array): void;
};

export type OwnedPtyProcessDependencies = {
  spawn: SpawnPty;
  readIdentity(pid?: number): Promise<ProcessIdentity>;
  readGroupId(pid: number): Promise<number>;
  terminateGroup(options: {
    identity: ProcessIdentity;
    processGroupId: number;
    terminationGraceMs: number;
    killGraceMs: number;
  }): Promise<void>;
};

const DEFAULT_TERMINATION_TIMEOUT_MS = 1_000;

export class OwnedPtyProcess implements AsyncDisposable {
  readonly proc: PtySubprocess;
  readonly terminal: PtyTerminal;
  readonly identity: ProcessIdentity;
  readonly info: OwnedProcessInfo;

  private cleanup?: Promise<void>;
  private acceptsData = true;
  private stopped = false;

  private constructor(
    proc: PtySubprocess,
    terminal: PtyTerminal,
    identity: ProcessIdentity,
    info: OwnedProcessInfo,
    private readonly options: OwnedPtyProcessOptions,
    private readonly dependencies: OwnedPtyProcessDependencies,
  ) {
    this.proc = proc;
    this.terminal = terminal;
    this.identity = identity;
    this.info = info;
  }

  static async spawn(
    options: OwnedPtyProcessOptions,
    dependencies: OwnedPtyProcessDependencies = defaultDependencies,
  ): Promise<OwnedPtyProcess> {
    let owner: OwnedPtyProcess | undefined;
    let acceptsData = true;
    const receive = (data: Uint8Array): void => {
      if (!acceptsData) return;
      if (owner) owner.receive(data);
      else options.onData?.(data);
    };
    const proc = dependencies.spawn(spawnOptions(options, receive));

    try {
      const identity = await dependencies.readIdentity(proc.pid);
      const ownerIdentity = await dependencies.readIdentity();
      const processGroupId = await dependencies.readGroupId(proc.pid);
      if (processGroupId !== proc.pid) {
        throw new Error(`PTY process ${proc.pid} does not own process group ${processGroupId}`);
      }
      if (!proc.terminal) throw new Error(`PTY process ${proc.pid} has no terminal`);

      const info: OwnedProcessInfo = {
        identity,
        ownerIdentity,
        processGroupId,
        kind: "pty",
      };
      owner = new OwnedPtyProcess(
        proc,
        proc.terminal,
        identity,
        info,
        options,
        dependencies,
      );
      await options.lifecycle?.started?.(info);
      options.signal?.addEventListener("abort", owner.abort, { once: true });
      void proc.exited.then(owner.exit, owner.exit);
      if (options.signal?.aborted) await owner.close();
      return owner;
    } catch (error) {
      acceptsData = false;
      proc.terminal?.close();
      proc.kill("SIGKILL");
      await proc.exited.catch(() => undefined);
      throw error;
    }
  }

  write(data: Parameters<Bun.Terminal["write"]>[0]): number {
    if (this.cleanup) throw new Error("cannot write to a closing PTY process");
    return this.terminal.write(data);
  }

  async wait(): Promise<number> {
    const exitCode = await this.proc.exited;
    await this.close();
    return exitCode;
  }

  async close(): Promise<void> {
    this.cleanup ??= this.stop();
    await this.cleanup;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private receive(data: Uint8Array): void {
    if (this.acceptsData) this.options.onData?.(data);
  }

  private readonly abort = (): void => {
    void this.close();
  };

  private readonly exit = (): void => {
    void this.close();
  };

  private async stop(): Promise<void> {
    this.acceptsData = false;
    this.options.signal?.removeEventListener("abort", this.abort);

    await this.dependencies.terminateGroup({
      identity: this.identity,
      processGroupId: this.info.processGroupId,
      terminationGraceMs: this.timeoutMs,
      killGraceMs: this.timeoutMs,
    });
    this.terminal.close();
    await this.publishStopped();
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

const defaultDependencies: OwnedPtyProcessDependencies = {
  spawn: (options) => Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.terminal.cols,
      rows: options.terminal.rows,
      name: options.terminal.name,
      data: (terminal, data) => options.terminal.data(terminal, data),
    },
  }),
  readIdentity: readProcessIdentity,
  readGroupId: readProcessGroupId,
  terminateGroup: terminateProcessGroup,
};

function spawnOptions(
  options: OwnedPtyProcessOptions,
  receive: (data: Uint8Array) => void,
): SpawnPtyOptions {
  return {
    cmd: [options.command, ...(options.args ?? [])],
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      name: options.name,
      data: (_terminal, data) => receive(data),
    },
  };
}
