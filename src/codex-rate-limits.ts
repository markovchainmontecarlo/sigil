import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { CodexProfile, CodexProfileClass } from "./codex-profiles.js";
import type { SubscriptionCapacity } from "./codex-router.js";
import { CODEX_EXECUTABLE } from "./config.js";
import { ProviderError } from "./provider-failure.js";
import { classifyProviderFailure } from "./provider-failure.js";
import { OwnedProcess, type ProcessLifecycle } from "./owned-process.js";

type RpcResponse = { id?: number; result?: unknown; error?: { code?: number; message?: string } };
type AccountResult = { account?: { type?: string } };
type RateLimitWindow = { usedPercent?: number };
type RateLimitResult = { rateLimits?: { primary?: RateLimitWindow } };
type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export type CodexAccountStatus = {
  profileClass: CodexProfileClass;
  capacity: SubscriptionCapacity;
};

export type CodexStatusOptions = {
  timeoutMs?: number;
  spawnAppServer?: (profile: CodexProfile) => ChildProcessWithoutNullStreams;
  processLifecycle?: ProcessLifecycle;
};

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export async function readCodexAccountStatus(
  profile: CodexProfile,
  options: CodexStatusOptions = {},
): Promise<CodexAccountStatus> {
  try {
    await using client = await createAppServerClient(profile, options);
    await client.request("initialize", { clientInfo: { name: "sigil", version: "1" } });

    const account = await client.request<AccountResult>("account/read");
    const profileClass = classifyAccount(account);
    if (profileClass === "metered-api") {
      return { profileClass, capacity: observedCapacity("unavailable") };
    }

    const limits = await client.request<RateLimitResult>("account/rateLimits/read");
    return { profileClass, capacity: subscriptionCapacity(limits) };
  } catch (error) {
    const failure = classifyProviderFailure(error);
    const kind = failure.code === "authentication_failed"
      ? "authentication"
      : failure.code === "invalid_request" ? "configuration" : "unknown";
    return {
      profileClass: profile.profileClass,
      capacity: observedCapacity(kind, failure.evidence.message),
    };
  }
}

async function createAppServerClient(
  profile: CodexProfile,
  options: CodexStatusOptions,
): Promise<AppServerClient> {
  const process = options.spawnAppServer
    ? await OwnedProcess.adopt(options.spawnAppServer(profile), {
        kind: "codex-app-server",
        lifecycle: options.processLifecycle,
      })
    : await spawnDefaultAppServer(profile, options.processLifecycle);
  return new AppServerClient(process, options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
}

function spawnDefaultAppServer(
  profile: CodexProfile,
  lifecycle: ProcessLifecycle | undefined,
): Promise<OwnedProcess> {
  const env = { ...process.env, CODEX_HOME: profile.home };
  return OwnedProcess.spawn({
    command: CODEX_EXECUTABLE,
    args: ["app-server"],
    env,
    kind: "codex-app-server",
    lifecycle,
  });
}

function classifyAccount(account: AccountResult): CodexProfileClass {
  if (account.account?.type === "apiKey") return "metered-api";
  if (account.account?.type === "chatgpt") return "subscription";
  throw new ProviderError("Codex account/read returned an unknown account type", {
    code: "invalid_request",
    operation: "account/read",
    account: account.account?.type ?? "missing",
  });
}

function subscriptionCapacity(limits: RateLimitResult): SubscriptionCapacity {
  const used = limits.rateLimits?.primary?.usedPercent;
  if (used === undefined) return observedCapacity("unknown", "rate limit percentage missing");
  return {
    kind: "available",
    available: true,
    observedAt: new Date().toISOString(),
    remainingPercentage: Math.max(0, 100 - used),
  };
}

function observedCapacity(
  kind: "unavailable" | "unknown" | "authentication" | "configuration",
  message?: string,
): SubscriptionCapacity {
  return { kind, available: false, observedAt: new Date().toISOString(), ...(message ? { message } : {}) };
}

class AppServerClient implements AsyncDisposable {
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly process: OwnedProcess,
    private readonly timeoutMs: number,
  ) {
    const child = process.child;
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.stdin.once("error", (error) => this.closeWithError(error));
    this.child.stdout.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      this.closeWithError(new Error(`Codex app-server exited before completing RPC requests (${code ?? signal ?? "unknown"})`));
    });
  }

  private readonly child: ChildProcessWithoutNullStreams;

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed"));

    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.rejectRequest(id, new ProviderError(`Codex app-server ${method} timed out`, {
          code: "operation_timeout",
          operation: method,
        })),
        this.timeoutMs,
      );
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
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
    await this.process.dispose();
  }

  private handleLine(line: string): void {
    const response = parseResponse(line);
    if (response.id === undefined) return;

    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.error) {
      request.reject(new ProviderError(
        `Codex app-server RPC failed: ${response.error.message ?? response.error.code ?? "unknown error"}`,
        {
          operation: request.method,
          rpcCode: response.error.code,
        },
      ));
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
