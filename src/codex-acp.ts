import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type NewSessionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import { OwnedProcess, type ProcessLifecycle } from "./owned-process.js";
import type { ProcessIdentity } from "./process-identity.js";

export type OwnedAcpOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  resumeSessionId?: string;
  onProcessStarted?: (identity: ProcessIdentity) => void | Promise<void>;
  onProcessStopped?: (identity: ProcessIdentity) => void | Promise<void>;
  processLifecycle?: ProcessLifecycle;
};

export type OwnedAcpEvent =
  | { type: "text"; text: string }
  | { type: "session-update"; update: SessionUpdate };

type PromptState = {
  sessionId: string;
  onEvent(event: OwnedAcpEvent): void;
};

export class OwnedCodexAcpConnection implements AsyncDisposable {
  private process?: OwnedProcess;
  private connection?: ClientSideConnection;
  private session?: NewSessionResponse;
  private initialization?: Promise<void>;
  private promptState?: PromptState;
  private stderr = "";

  constructor(private readonly options: OwnedAcpOptions) {}

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get childIdentity(): ProcessIdentity | undefined {
    return this.process?.identity;
  }

  async *promptStream(text: string, signal?: AbortSignal): AsyncGenerator<OwnedAcpEvent> {
    await this.ensureConnected();
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    const queue = createAsyncQueue<OwnedAcpEvent>();
    const state = { sessionId, onEvent: (event: OwnedAcpEvent) => queue.push(event) };
    let aborting = false;
    const abort = () => {
      aborting = true;
      void this.disconnect().then(
        () => queue.fail(signal?.reason ?? new Error("ACP prompt aborted")),
        (error) => queue.fail(error),
      );
    };

    this.promptState = state;
    signal?.addEventListener("abort", abort, { once: true });
    const response = connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    }).then(
      (result) => result.stopReason === "end_turn"
        ? queue.close()
        : queue.fail(new Error(`ACP prompt stopped before completing: ${result.stopReason}`)),
      (error) => {
        if (!aborting) queue.fail(this.withStderr(error));
      },
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
    await this.process?.dispose();
    this.process = undefined;
  }

  private async ensureConnected(): Promise<void> {
    this.initialization ??= this.initialize();
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    this.stderr = "";
    const owned = await OwnedProcess.spawn({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      kind: "acp",
      lifecycle: combineLifecycle(this.options),
    });
    this.process = owned;
    owned.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });

    const stream = ndJsonStream(
      Writable.toWeb(owned.child.stdin),
      Readable.toWeb(owned.child.stdout),
    );
    const connection = new ClientSideConnection(
      () => createAcpClient(() => this.promptState),
      stream,
    );
    this.connection = connection;

    try {
      await connection.initialize(initializeRequest());
      this.session = await createOrResumeSession(connection, this.options);
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

function combineLifecycle(options: OwnedAcpOptions): ProcessLifecycle {
  return {
    async started(process) {
      await options.processLifecycle?.started?.(process);
      await options.onProcessStarted?.(process.identity);
    },
    async stopped(process) {
      await options.processLifecycle?.stopped?.(process);
      await options.onProcessStopped?.(process.identity);
    },
  };
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
