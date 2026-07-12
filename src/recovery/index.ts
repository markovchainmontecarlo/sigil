import type { ProviderFailure } from "../provider-failure.js";

export type FailureKind =
  | "baseline"
  | "gate"
  | "review"
  | "provider"
  | "checkpoint"
  | "authority";

export type WorkflowFailure = {
  kind: FailureKind;
  stage: string;
  evidence: string;
  paths?: string[];
  attempts: number;
  recoverable: boolean;
  provider?: ProviderFailure;
};

export type RecoveryAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; failure: WorkflowFailure };

export type RecoveryResult<T> =
  | { ok: true; value: T; attempts: number; failures: WorkflowFailure[] }
  | { ok: false; failure: WorkflowFailure; attempts: number; failures: WorkflowFailure[] };

export type RecoveryOptions<T> = {
  limit: number;
  attempt: (attempt: number, failures: WorkflowFailure[]) => Promise<RecoveryAttempt<T>>;
  repair: (failure: WorkflowFailure, attempt: number) => Promise<void>;
  record?: (failure: WorkflowFailure) => Promise<void>;
};

export type OperationRecoveryOptions<T> = {
  limit: number;
  run: (attempt: number, controls: OperationAttemptControls) => Promise<T>;
  failure: (error: unknown, attempt: number, recoverable: boolean) => WorkflowFailure;
  record?: (failure: WorkflowFailure) => Promise<void>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cancellationGraceMs?: number;
  operation?: string;
};

export type OperationProgress = "text" | "tool" | "provider";
export type OperationAttemptControls = {
  signal: AbortSignal;
  progress(kind: OperationProgress): void;
};

const DEFAULT_CANCELLATION_GRACE_MS = 5_000;

class OperationTimeoutError extends Error {
  constructor(
    message: string,
    readonly cancellationSettled: boolean,
  ) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export async function recover<T>(options: RecoveryOptions<T>): Promise<RecoveryResult<T>> {
  const failures: WorkflowFailure[] = [];
  for (let attempt = 1; attempt <= options.limit + 1; attempt++) {
    const result = await options.attempt(attempt, failures);
    if (result.ok) return { ok: true, value: result.value, attempts: attempt, failures };

    const failure = { ...result.failure, attempts: attempt };
    failures.push(failure);
    await options.record?.(failure);
    if (!failure.recoverable || attempt > options.limit) {
      return { ok: false, failure, attempts: attempt, failures };
    }

    await options.repair(failure, attempt);
  }
  throw new Error("recovery loop exhausted without a result");
}

export async function retryOperation<T>(
  options: OperationRecoveryOptions<T>,
): Promise<RecoveryResult<T>> {
  const failures: WorkflowFailure[] = [];
  for (let attempt = 1; attempt <= options.limit + 1; attempt++) {
    try {
      const value = await runAttempt(options, attempt);
      return { ok: true, value, attempts: attempt, failures };
    } catch (error) {
      const recoverable = attempt <= options.limit;
      const cancellationSettled = !(error instanceof OperationTimeoutError)
        || error.cancellationSettled;
      const failure = options.failure(
        error,
        attempt,
        recoverable && cancellationSettled,
      );
      failures.push(failure);
      await options.record?.(failure);
      if (!failure.recoverable) {
        return { ok: false, failure, attempts: attempt, failures };
      }
    }
  }
  throw new Error("operation recovery loop exhausted without a result");
}

async function runAttempt<T>(
  options: OperationRecoveryOptions<T>,
  attempt: number,
): Promise<T> {
  const controller = new AbortController();
  const name = options.operation ?? "agent operation";
  let idle: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timeoutMessage: string | undefined;
  let rejectTimeout: (error: Error) => void = () => {};
  const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const expire = (error: Error) => {
    if (controller.signal.aborted) return;
    timeoutMessage = error.message;
    controller.abort(error);
    rejectTimeout(error);
  };
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    if (options.idleTimeoutMs) {
      idle = setTimeout(
        () => expire(new Error(`${name} idle timeout after ${options.idleTimeoutMs}ms`)),
        options.idleTimeoutMs,
      );
    }
  };
  resetIdle();
  if (options.timeoutMs) {
    deadline = setTimeout(
      () => expire(new Error(`${name} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
  }
  const operation = options.run(attempt, {
    signal: controller.signal,
    progress: () => resetIdle(),
  });
  const settlement: Promise<true> = operation.then(
    () => true as const,
    () => true as const,
  );
  try {
    return await Promise.race([operation, timedOut]);
  } catch (error) {
    if (timeoutMessage) {
      const cancellationSettled = await settlesWithin(
        settlement,
        options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS,
      );
      throw new OperationTimeoutError(timeoutMessage, cancellationSettled);
    }
    throw error;
  } finally {
    if (idle) clearTimeout(idle);
    if (deadline) clearTimeout(deadline);
  }
}

async function settlesWithin(
  settlement: Promise<true>,
  graceMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });

  try {
    return await Promise.race([settlement, graceExpired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
