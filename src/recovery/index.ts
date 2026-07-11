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
  run: (attempt: number) => Promise<T>;
  failure: (error: unknown, attempt: number, recoverable: boolean) => WorkflowFailure;
  record?: (failure: WorkflowFailure) => Promise<void>;
  timeoutMs?: number;
  operation?: string;
};

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
      const value = await runWithTimeout(
        options.run(attempt),
        options.timeoutMs,
        options.operation ?? "agent operation",
      );
      return { ok: true, value, attempts: attempt, failures };
    } catch (error) {
      const recoverable = attempt <= options.limit;
      const failure = options.failure(error, attempt, recoverable);
      failures.push(failure);
      await options.record?.(failure);
      if (!recoverable) {
        return { ok: false, failure, attempts: attempt, failures };
      }
    }
  }
  throw new Error("operation recovery loop exhausted without a result");
}

async function runWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  name: string,
): Promise<T> {
  if (!timeoutMs) return operation;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
