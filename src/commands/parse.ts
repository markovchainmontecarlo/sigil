import { parseArgs } from "node:util";

import { UsageError } from "./errors.js";

export type ParsedArgs = ReturnType<typeof parseArgs>;
export type ParseOptions = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

export function parseCommandArgs(args: string[], options: ParseOptions): ParsedArgs {
  return parseArgs({ args, options, allowPositionals: true });
}

export function value(parsed: ParsedArgs, name: string): string | undefined {
  const raw = parsed.values[name];
  return typeof raw === "string" ? raw : undefined;
}

export function requireValue(parsed: ParsedArgs, name: string): string {
  const raw = value(parsed, name);
  if (!raw) throw new UsageError(`missing required --${name}`);
  return raw;
}

export function rejectPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length) throw new UsageError("unexpected positional argument");
}

export function repeatedValues(parsed: ParsedArgs, name: string): string[] | undefined {
  const raw = parsed.values[name];
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}
