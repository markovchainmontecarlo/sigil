export class UsageError extends Error {}

export function isUsageError(error: unknown): boolean {
  return error instanceof UsageError || isParseArgsError(error);
}

export function printUnhandledError(error: unknown): void {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

function isParseArgsError(error: unknown): boolean {
  return error instanceof TypeError
    && "code" in error
    && String(error.code).startsWith("ERR_PARSE_ARGS");
}
