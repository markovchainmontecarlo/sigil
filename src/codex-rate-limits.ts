import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { CodexProfile, CodexProfileClass } from "./codex-profiles.js";
import type { SubscriptionCapacity } from "./codex-router.js";
import { CODEX_EXECUTABLE } from "./config.js";

type RpcResponse = { id?: number; result?: unknown; error?: { code?: number; message?: string } };
type AccountResult = { account?: { type?: string } };
type RateLimitWindow = { usedPercent?: number };
type RateLimitResult = { rateLimits?: { primary?: RateLimitWindow } };
type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexAccountStatus = {
  profileClass: CodexProfileClass;
  capacity: SubscriptionCapacity;
};

export type CodexStatusOptions = {
  timeoutMs?: number;
  spawnAppServer?: (profile: CodexProfile) => ChildProcessWithoutNullStreams;
};

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export async function readCodexAccountStatus(
  profile: CodexProfile,
  options: CodexStatusOptions = {},
): Promise<CodexAccountStatus> {
  await using client = createAppServerClient(profile, options);
  await client.request("initialize", { clientInfo: { name: "sigil", version: "1" } });

  const account = await client.request<AccountResult>("account/read");
  const profileClass = classifyAccount(account);
  if (profileClass === "metered-api") {
    return { profileClass, capacity: { available: false } };
  }

  const limits = await client.request<RateLimitResult>("account/rateLimits/read");
  return { profileClass, capacity: subscriptionCapacity(limits) };
}

function createAppServerClient(
  profile: CodexProfile,
  options: CodexStatusOptions,
): AppServerClient {
  const child = options.spawnAppServer?.(profile) ?? spawnDefaultAppServer(profile);
  return new AppServerClient(child, options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
}

function spawnDefaultAppServer(profile: CodexProfile): ChildProcessWithoutNullStreams {
  const env = { ...process.env, CODEX_HOME: profile.home };
  return spawn(
    CODEX_EXECUTABLE,
    ["app-server"],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function classifyAccount(account: AccountResult): CodexProfileClass {
  if (account.account?.type === "apiKey") return "metered-api";
  if (account.account?.type === "chatgpt") return "subscription";
  throw new Error("Codex account/read returned an unknown account type");
}

function subscriptionCapacity(limits: RateLimitResult): SubscriptionCapacity {
  const used = limits.rateLimits?.primary?.usedPercent;
  if (used === undefined) return { available: false };
  return {
    available: true,
    remainingPercentage: Math.max(0, 100 - used),
  };
}

class AppServerClient implements AsyncDisposable {
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.stdin.once("error", (error) => this.closeWithError(error));
    this.child.stdout.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      this.closeWithError(new Error(`Codex app-server exited before completing RPC requests (${code ?? signal ?? "unknown"})`));
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed"));

    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.rejectRequest(id, new Error(`Codex app-server ${method} timed out`)),
        this.timeoutMs,
      );
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      (error) => {
        if (error) this.rejectRequest(id, error);
      },
    );
    return response;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.closeWithError(new Error("Codex app-server connection closed"));
    this.lines.close();
    if (!this.child.killed) this.child.kill();
  }

  private handleLine(line: string): void {
    const response = parseResponse(line);
    if (response.id === undefined) return;

    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.error) {
      request.reject(new Error(`Codex app-server RPC failed: ${response.error.message ?? response.error.code ?? "unknown error"}`));
      return;
    }
    request.resolve(response.result);
  }

  private rejectRequest(id: number, error: Error): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.reject(error);
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.rejectRequest(id, error);
  }
}

function parseResponse(line: string): RpcResponse {
  try {
    return JSON.parse(line) as RpcResponse;
  } catch {
    return {};
  }
}
