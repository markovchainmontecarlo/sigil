import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig, resolveEvalCommand } from "./config.js";
import type { SigilAgent } from "./agent.js";
import { extractFailureLog } from "./reports/failure-log.js";
import { OwnedProcess, type ProcessLifecycle } from "./owned-process.js";

export type EmitResult = { ok: true; contents: string[] } | { ok: false; contents: string[]; issue: string };
export type EmitOptions = { minBytes?: number; attempts?: number; mustChange?: boolean };
export type EvalGateResult =
  | { ok: boolean; log: string; skipped?: false; command?: string; cwd?: string; exitCode?: number }
  | { ok: true; skipped: true; log?: string; command?: undefined; cwd?: undefined; exitCode?: undefined };
export type RetryValidation<TSuccess extends { ok: true }> = TSuccess | { ok: false; issue: string };
export type RetryLoopOptions<TSuccess extends { ok: true }> = {
  initialPrompt: string;
  attempts: number;
  runTurn(prompt: string): Promise<void>;
  validate(): Promise<RetryValidation<TSuccess>>;
  correctionPrompt(issue: string, initialPrompt: string): string;
  defaultIssue?: string;
  turnFailureIssue?(error: unknown): string;
};
export type RetryLoopResult<TSuccess extends { ok: true }> = TSuccess | { ok: false; issue: string };

const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function retryPromptLoop<TSuccess extends { ok: true }>(options: RetryLoopOptions<TSuccess>): Promise<RetryLoopResult<TSuccess>> {
  let issue = options.defaultIssue ?? "prompt gate failed";

  for (let attempt = 0; attempt <= options.attempts; attempt++) {
    const turnPrompt = attempt === 0 ? options.initialPrompt : options.correctionPrompt(issue, options.initialPrompt);
    try {
      await options.runTurn(turnPrompt);
      const checked = await options.validate();
      if (checked.ok) return checked;
      issue = checked.issue;
    } catch (error) {
      issue = options.turnFailureIssue?.(error) ?? `agent turn failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return { ok: false, issue };
}

export async function emit(agent: SigilAgent, prompt: string, fileOrFiles: string | string[], opts: EmitOptions = {}): Promise<EmitResult> {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  const minBytes = opts.minBytes ?? 50;
  const attempts = opts.attempts ?? 2;
  const before = new Map<string, string>();

  try {
    for (const file of files) {
      const content = await readExisting(file);
      if (content !== undefined) before.set(file, hash(content));
    }
  } catch (error) {
    return { ok: false, contents: [], issue: `artifact snapshot failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = await retryPromptLoop<Extract<EmitResult, { ok: true }>>({
    initialPrompt: prompt,
    attempts,
    runTurn: (turnPrompt) => agent.prompt(turnPrompt).then(() => undefined),
    validate: () => checkFiles(files, before, minBytes, opts.mustChange),
    correctionPrompt: artifactCorrectionPrompt,
    defaultIssue: "artifact gate failed",
  });

  return result.ok ? result : { ok: false, contents: [], issue: result.issue };
}

function artifactCorrectionPrompt(issue: string, prompt: string): string {
  return `Your previous turn failed its artifact gate: ${issue}. You MUST write the requested file now. Original instruction follows.\n\n${prompt}`;
}

async function checkFiles(files: string[], before: Map<string, string>, minBytes: number, mustChange?: boolean): Promise<EmitResult> {
  const contents: string[] = [];
  for (const file of files) {
    const content = await readExisting(file);
    if (content === undefined) return { ok: false, contents, issue: `${file} is missing` };
    if (content.trim().length < minBytes) return { ok: false, contents, issue: `${file} trimmed content is under ${minBytes} bytes` };

    const beforeHash = before.get(file);
    const changeRequired = mustChange === true || beforeHash !== undefined;
    if (changeRequired && beforeHash !== undefined && hash(content) === beforeHash) {
      return { ok: false, contents, issue: `${file} is byte-identical; it was not rewritten` };
    }
    contents.push(content);
  }
  return { ok: true, contents };
}

export type EvalGateOptions = {
  cwd?: string;
  signal?: AbortSignal;
  processLifecycle?: ProcessLifecycle;
};

export async function evalGate(name: string, opts: EvalGateOptions = {}): Promise<EvalGateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const command = resolveEvalCommand(name, loadConfig(cwd));
  if (!command) return { ok: true, skipped: true };

  await using owned = await OwnedProcess.spawn({
    command: "bash",
    args: ["-lc", command],
    cwd,
    kind: "gate",
    signal: opts.signal,
    lifecycle: opts.processLifecycle,
  });
  const result = await owned.wait();
  const code = result.exitCode ?? 1;
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    ok: code === 0,
    log: extractFailureLog(combined),
    command,
    cwd,
    exitCode: code,
  };
}
