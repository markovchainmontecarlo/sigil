import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";

import { createContext, type SigilContext } from "../context.js";
import { artifactDir } from "../paths.js";
import { breakdown } from "../workflows/breakdown/index.js";
import { dispatch } from "../workflows/dispatch/index.js";
import { implement } from "../workflows/software-change/implementation/index.js";
import { plan } from "../workflows/software-change/planning/index.js";
import { review } from "../workflows/software-change/review/index.js";
import { softwareChange } from "../workflows/software-change/workflow.js";
import { compileYamlWorkflow } from "./compile.js";
import { parseYamlWorkflow, validateYamlWorkflowFile } from "./validate.js";
import type { CompiledYamlWorkflow, YamlRunResult, YamlStep } from "./types.js";

const OUTPUT_REF = /\$([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.output(?:\.([a-zA-Z0-9_.-]+))?/g;
const ARTIFACT_REF = /\$artifacts\/([^\s)]+)/g;

const shippedWorkflows = { "software-change": softwareChange, plan, implement, review, breakdown, dispatch } as const;

type WorkflowState = {
  outputs: Map<string, unknown>;
  artifacts: Map<string, string>;
};

function resolvePath(value: unknown, path: string | undefined): unknown {
  if (!path || value === null || typeof value !== "object") return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function interpolateString(value: string, state: WorkflowState): string {
  return value
    .replace(OUTPUT_REF, (_full, job, step, path) => {
      const output = state.outputs.get(`${job}.${step}`);
      const resolved = resolvePath(output, path);
      return resolved === undefined ? "" : String(resolved);
    })
    .replace(ARTIFACT_REF, (_full, name) => state.artifacts.get(name) ?? "");
}

function interpolateValue(value: unknown, state: WorkflowState): unknown {
  if (typeof value === "string") return interpolateString(value, state);
  if (Array.isArray(value)) return value.map((entry) => interpolateValue(entry, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, state)]));
  }
  return value;
}

function parseLiteral(token: string, state: WorkflowState): unknown {
  if (token === "true") return true;
  if (token === "false") return false;
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) return token.slice(1, -1);
  if (token.startsWith("$")) return interpolateString(token, state);
  return token;
}

function shouldRun(condition: string | undefined, state: WorkflowState): boolean {
  if (!condition) return true;
  const match = condition.match(/^\s*(\$[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|true|false|'[^']*'|"[^"]*")\s*(==|!=)\s*(\$[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|true|false|'[^']*'|"[^"]*")\s*$/);
  if (!match) return false;
  const left = parseLiteral(match[1], state);
  const right = parseLiteral(match[3], state);
  return match[2] === "==" ? left === right : left !== right;
}

function runShell(script: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", script], { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(combined || String(error)));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

function buildOutputSchema(step: Extract<YamlStep, { prompt: string }>) {
  if (!step.output?.enum?.length) return undefined;
  const values = step.output.enum;
  return z.enum([values[0]!, ...values.slice(1)]);
}

async function runStep(
  ctx: SigilContext,
  repo: string,
  jobId: string,
  step: YamlStep,
  agentBinding: string | import("../config.js").AgentBinding | undefined,
  agentCache: { current?: ReturnType<SigilContext["agent"]> },
  state: WorkflowState,
): Promise<{ id: string; kind: string; skipped: boolean; output?: unknown }> {
  const kind = ["prompt", "eval", "run", "script", "sh"].find((key) => key in step) ?? "unknown";
  if (!shouldRun(step.condition, state)) return { id: step.id, kind, skipped: true };

  if ("prompt" in step) {
    agentCache.current ??= ctx.agent(agentBinding!);
    const prompt = interpolateString(step.prompt, state);
    const schema = buildOutputSchema(step as Extract<YamlStep, { prompt: string }>);
    let output: unknown;
    if (step.writes) {
      output = await agentCache.current.prompt(prompt, {
        writes: step.writes,
        minBytes: step.minBytes,
      });
      state.artifacts.set(step.writes, ctx.artifacts.path(step.writes));
    } else if (schema) {
      output = await agentCache.current.prompt(prompt, schema as never);
    } else {
      output = await agentCache.current.prompt(prompt);
    }
    state.outputs.set(`${jobId}.${step.id}`, output);
    return { id: step.id, kind, skipped: false, output };
  }

  if ("eval" in step) {
    const output = await ctx.evals(step.eval);
    state.outputs.set(`${jobId}.${step.id}`, output);
    return { id: step.id, kind, skipped: false, output };
  }

  if ("run" in step) {
    const input = interpolateValue(step.run.input ?? {}, state) as Record<string, unknown>;
    const workflow = shippedWorkflows[step.run.workflow];
    const output = await ctx.run(workflow as never, { repo, ...input } as never);
    state.outputs.set(`${jobId}.${step.id}`, output);
    return { id: step.id, kind, skipped: false, output };
  }

  const script = interpolateString((step as { script?: string; sh?: string }).script ?? (step as { sh?: string }).sh ?? "", state);
  const output = await runShell(script, repo);
  state.outputs.set(`${jobId}.${step.id}`, output);
  return { id: step.id, kind, skipped: false, output };
}

async function runCompiledWorkflow(compiled: CompiledYamlWorkflow, repo: string, ctx: SigilContext): Promise<YamlRunResult> {
  const state: WorkflowState = { outputs: new Map(), artifacts: new Map() };
  const stageResults: YamlRunResult["stageResults"] = [];

  for (const stage of compiled.stages) {
    const jobResults = await ctx.parallel(
      stage.jobs.map((job) => async () => {
        if (!shouldRun(job.condition, state)) {
          return { id: job.id, skipped: true, stepResults: [] };
        }
        const agentCache: { current?: ReturnType<SigilContext["agent"]> } = {};
        try {
          const stepResults = [];
          for (const step of job.steps) {
            stepResults.push(await runStep(ctx, repo, job.id, step, job.kind === "agent-job" ? job.agent : undefined, agentCache, state));
          }
          return { id: job.id, skipped: false, stepResults };
        } finally {
          if (agentCache.current) await agentCache.current.close();
        }
      }),
    );
    stageResults.push({ id: stage.id, jobResults });
  }

  return {
    workflow: compiled.name,
    stageResults,
    issues: [...ctx.issues],
    artifacts: Object.fromEntries(state.artifacts.entries()),
  };
}

export async function runYamlWorkflowFile(file: string, repo: string, ctxOverride?: SigilContext): Promise<YamlRunResult> {
  const checked = validateYamlWorkflowFile(file, repo);
  if (checked.errors.length || !checked.workflow) throw new Error(checked.errors.join("\n") || "invalid yaml workflow");
  const compiled = compileYamlWorkflow(checked.workflow, repo);
  return runCompiledWorkflow(compiled, repo, ctxOverride ?? createContext(repo));
}

export function defaultYamlRunDir(repo: string, file: string): string {
  return join(artifactDir(repo), "yaml", file.split(/[\\/]/).pop() ?? "workflow");
}

export { parseYamlWorkflow, validateYamlWorkflowFile } from "./validate.js";
export { compileYamlWorkflow } from "./compile.js";
