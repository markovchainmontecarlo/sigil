import { createHash } from "node:crypto";

export type ProviderFailureCode =
  | "capacity_exhausted"
  | "authentication_failed"
  | "operation_timeout"
  | "idle_timeout"
  | "transient"
  | "invalid_request"
  | "cancelled"
  | "unknown";

export type ProviderRetryDisposition = "retry" | "reroute" | "terminal";

export type ProviderFailureEvidence = {
  name: string;
  message: string;
  cause?: ProviderFailureEvidence | string;
  stderr?: string;
  operation?: string;
  account?: string;
  rpcCode?: number;
};

export type ProviderFailure = {
  code: ProviderFailureCode;
  disposition: ProviderRetryDisposition;
  fingerprint: string;
  evidence: ProviderFailureEvidence;
};

export type ProviderErrorDetails = {
  operation?: string;
  account?: string;
  rpcCode?: number;
  stderr?: string;
};

export class ProviderError extends Error {
  readonly providerCode?: ProviderFailureCode;
  readonly details: ProviderErrorDetails;

  constructor(
    message: string,
    options: ProviderErrorDetails & { code?: ProviderFailureCode; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.providerCode = options.code;
    this.details = options;
  }
}

const DISPOSITIONS: Record<ProviderFailureCode, ProviderRetryDisposition> = {
  capacity_exhausted: "reroute",
  authentication_failed: "terminal",
  operation_timeout: "retry",
  idle_timeout: "retry",
  transient: "retry",
  invalid_request: "terminal",
  cancelled: "terminal",
  unknown: "retry",
};

const RULES: Array<{ code: ProviderFailureCode; pattern: RegExp }> = [
  {
    code: "capacity_exhausted",
    pattern: /(?:rate.?limit|quota|capacity).*(?:exhaust|exceed|reached)|(?:too many requests|usage limit)/i,
  },
  {
    code: "authentication_failed",
    pattern: /(?:unauthori[sz]ed|authentication|not logged in|invalid api key|expired token|missing credentials|access token)/i,
  },
  {
    code: "idle_timeout",
    pattern: /(?:idle|inactivity).*(?:timeout|timed out)|(?:timeout|timed out).*(?:idle|inactivity)/i,
  },
  { code: "operation_timeout", pattern: /(?:timed out|timeout|deadline exceeded)/i },
  {
    code: "invalid_request",
    pattern: /(?:invalid request|invalid argument|bad request|malformed|unknown account type|unsupported model)/i,
  },
  { code: "cancelled", pattern: /(?:cancelled|canceled|aborted|aborterror)/i },
  {
    code: "transient",
    pattern: /(?:temporar|try again|connection (?:reset|closed|refused)|econnreset|econnrefused|service unavailable|bad gateway|gateway timeout|internal server error)/i,
  },
];

export function classifyProviderFailure(error: unknown): ProviderFailure {
  const evidence = providerFailureEvidence(error);
  const explicit = error instanceof ProviderError ? error.providerCode : undefined;
  const code = explicit ?? classifyMessage(combinedEvidence(evidence), evidence.rpcCode);
  const identity = fingerprintIdentity(code, evidence);

  return {
    code,
    disposition: DISPOSITIONS[code],
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    evidence,
  };
}

export function providerFailureEvidence(error: unknown): ProviderFailureEvidence {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }

  const details = error instanceof ProviderError ? error.details : {};
  const split = splitAcpStderr(error.message);
  return {
    name: error.name,
    message: split.message,
    cause: serializableCause(error.cause),
    stderr: details.stderr ?? split.stderr,
    operation: details.operation,
    account: details.account,
    rpcCode: details.rpcCode,
  };
}

function classifyMessage(message: string, rpcCode: number | undefined): ProviderFailureCode {
  if (rpcCode === -32600 || rpcCode === -32602) return "invalid_request";
  const matched = RULES.find((rule) => rule.pattern.test(message));
  return matched?.code ?? "unknown";
}

function fingerprintIdentity(code: ProviderFailureCode, evidence: ProviderFailureEvidence): string {
  const structured = [evidence.operation, evidence.account, evidence.rpcCode]
    .filter((value) => value !== undefined)
    .join(":");
  if (structured) return `${code}:${structured}`;
  if (code !== "unknown" && code !== "invalid_request") return code;
  return `${code}:${normalizeMessage(combinedEvidence(evidence))}`;
}

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function combinedEvidence(evidence: ProviderFailureEvidence): string {
  return [evidence.message, evidence.stderr].filter(Boolean).join("\n");
}

function splitAcpStderr(message: string): { message: string; stderr?: string } {
  const marker = "\n\nACP agent stderr:\n";
  const index = message.indexOf(marker);
  if (index < 0) return { message };
  return {
    message: message.slice(0, index),
    stderr: message.slice(index + marker.length),
  };
}

function serializableCause(cause: unknown): ProviderFailureEvidence | string | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return providerFailureEvidence(cause);
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
