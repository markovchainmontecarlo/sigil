import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type NewSessionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import { readProcessIdentity, type ProcessIdentity } from "./process-identity.js";

export type OwnedAcpOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  model?: string;
  resumeSessionId?: string;
  onProcessStarted?: (identity: ProcessIdentity) => void | Promise<void>;
};

export type OwnedAcpEvent =
  | { type: "text"; text: string }
  | { type: "session-update"; update: SessionUpdate };

type PromptState = {
  sessionId: string;
  onEvent(event: OwnedAcpEvent): void;
};

export class OwnedCodexAcpConnection implements AsyncDisposable {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private session?: NewSessionResponse;
  private initialization?: Promise<void>;
  private promptState?: PromptState;
  private stderr = "";
  private identity?: ProcessIdentity;

  constructor(private readonly options: OwnedAcpOptions) {}

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get childIdentity(): ProcessIdentity | undefined {
    return this.identity;
  }

  async *promptStream(text: string, signal?: AbortSignal): AsyncGenerator<OwnedAcpEvent> {
    await this.ensureConnected();
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    const queue = createAsyncQueue<OwnedAcpEvent>();
    const state = { sessionId, onEvent: (event: OwnedAcpEvent) => queue.push(event) };
    const abort = () => queue.fail(signal?.reason ?? new Error("ACP prompt aborted"));

    this.promptState = state;
    signal?.addEventListener("abort", abort, { once: true });
    const response = connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    }).then(
      (result) => result.stopReason === "end_turn"
        ? queue.close()
        : queue.fail(new Error(`ACP prompt stopped before completing: ${result.stopReason}`)),
      (error) => queue.fail(this.withStderr(error)),
    );

    try {
      for await (const event of queue) yield event;
      await response;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.promptState === state) this.promptState = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    this.connection = undefined;
    this.session = undefined;
    this.initialization = undefined;
    this.promptState = undefined;
    if (this.child && !this.child.killed) await terminateOwnedProcess(this.child);
    this.child = undefined;
    this.identity = undefined;
  }

  private async ensureConnected(): Promise<void> {
    this.initialization ??= this.initialize();
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    this.stderr = "";
    const child = spawnOwnedProcess(this.options);
    this.child = child;
    child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.identity = await readProcessIdentity(child.pid);
    await this.options.onProcessStarted?.(this.identity);

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const connection = new ClientSideConnection(
      () => createAcpClient(() => this.promptState),
      stream,
    );
    this.connection = connection;

    try {
      await connection.initialize(initializeRequest());
      this.session = await createOrResumeSession(connection, this.options);
      if (this.options.model) await connection.unstable_setSessionModel({
        sessionId: this.session.sessionId,
        modelId: this.options.model,
      });
    } catch (error) {
      await this.disconnect();
      throw this.withStderr(error);
    }
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) throw new Error("ACP connection is not initialized");
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.session?.sessionId) throw new Error("ACP session is not initialized");
    return this.session.sessionId;
  }

  private withStderr(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = this.stderr.trim();
    return new Error(stderr ? `${message}\n\nACP agent stderr:\n${stderr}` : message);
  }
}

function spawnOwnedProcess(options: OwnedAcpOptions): ChildProcessWithoutNullStreams {
  return spawn(
    options.command,
    options.args,
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function initializeRequest() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "sigil", version: "1" },
  };
}

async function createOrResumeSession(
  connection: ClientSideConnection,
  options: OwnedAcpOptions,
): Promise<NewSessionResponse> {
  const request = { cwd: options.cwd, mcpServers: [] };
  if (!options.resumeSessionId) return connection.newSession(request);
  const resumed = await connection.resumeSession({
    ...request,
    sessionId: options.resumeSessionId,
  });
  return { ...resumed, sessionId: options.resumeSessionId } as NewSessionResponse;
}

function createAcpClient(getState: () => PromptState | undefined): Client {
  return {
    async sessionUpdate(notification) {
      const state = getState();
      if (!state || notification.sessionId !== state.sessionId) return;
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        state.onEvent({ type: "text", text: update.content.text });
        return;
      }
      state.onEvent({ type: "session-update", update });
    },
    async requestPermission(request) {
      const option = request.options[0];
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async readTextFile(request) {
      const contents = await readFile(request.path, "utf8");
      const lines = contents.split("\n");
      const start = (request.line ?? 1) - 1;
      const end = request.limit == null ? lines.length : start + request.limit;
      return { content: lines.slice(start, end).join("\n") };
    },
    async writeTextFile(request) {
      await writeFile(request.path, request.content);
      return {};
    },
  };
}

async function terminateOwnedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  const exited = waitForExit(child);
  terminateProcessGroup(pid, "SIGTERM");
  if (await settledWithin(exited, 1_000)) return;
  terminateProcessGroup(pid, "SIGKILL");
  await settledWithin(exited, 1_000);
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    return;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function settledWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function createAsyncQueue<T>(): AsyncIterable<T> & {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
} {
  const values: T[] = [];
  const waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  let closed = false;
  let failure: unknown;

  const next = (): Promise<IteratorResult<T>> => {
    if (values.length) return Promise.resolve({ value: values.shift()!, done: false });
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
    },
    fail(error) {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };
}
