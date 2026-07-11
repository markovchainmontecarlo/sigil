import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

import { loadConfig } from "../config.js";
import { YamlWorkflowSchema } from "./schema.js";
import type { YamlJob, YamlStep, YamlValidationResult, YamlWorkflow } from "./types.js";

const STEP_KIND_ORDER = ["prompt", "eval", "run", "script", "sh"] as const;
const WORKFLOW_REF = /^\$([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.output(?:\.([a-zA-Z0-9_.-]+))?$/;
const ARTIFACT_REF = /^\$artifacts\/([^\s]+)$/;

function stepKind(step: YamlStep): string {
  for (const key of STEP_KIND_ORDER) {
    if (key in step) return key;
  }
  return "unknown";
}

function collectRefs(value: unknown): string[] {
  if (typeof value === "string") {
    const matches = value.match(/\$[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|\$artifacts\/[^\s)]+/g);
    return matches ?? [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectRefs(entry));
  if (value && typeof value === "object") return Object.values(value).flatMap((entry) => collectRefs(entry));
  return [];
}

function checkCondition(condition: string): string | undefined {
  const match = condition.match(/^\s*(\$[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|true|false|'[^']*'|"[^"]*")\s*(==|!=)\s*(\$[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|true|false|'[^']*'|"[^"]*")\s*$/);
  if (!match) return `unsupported condition grammar: ${condition}`;
  return undefined;
}

function validateStepRefs(
  step: YamlStep,
  scope: string,
  availableOutputs: Set<string>,
  availableArtifacts: Set<string>,
  errors: string[],
): void {
  if (step.condition) {
    const issue = checkCondition(step.condition);
    if (issue) errors.push(`${scope} ${step.id}: ${issue}`);
  }

  for (const ref of collectRefs(step)) {
    const outputMatch = ref.match(WORKFLOW_REF);
    if (outputMatch) {
      const key = `${outputMatch[1]}.${outputMatch[2]}`;
      if (!availableOutputs.has(key)) errors.push(`${scope} ${step.id}: unknown output reference ${ref}`);
      continue;
    }

    const artifactMatch = ref.match(ARTIFACT_REF);
    if (artifactMatch) {
      if (!availableArtifacts.has(artifactMatch[1])) errors.push(`${scope} ${step.id}: unknown artifact reference ${ref}`);
    }
  }
}

function validateJobKinds(job: YamlJob, errors: string[]): void {
  const kinds = new Set(job.steps.map((step) => stepKind(step)));
  const hasAgent = job.agent !== undefined;
  const hasPrompt = kinds.has("prompt");
  const hasScript = kinds.has("script") || kinds.has("sh");

  if (hasAgent && hasScript) errors.push(`job ${job.id}: agent jobs cannot contain script or sh steps`);
  if (!hasAgent && hasPrompt) errors.push(`job ${job.id}: prompt steps require an agent job`);
}

function validateAgentRefs(workflow: YamlWorkflow, repo: string, errors: string[]): void {
  const needsConfig = workflow.stages.some((stage) =>
    (stage.jobs ?? []).some((job) => typeof job.agent === "string"),
  );
  if (!needsConfig) return;

  let config;
  try {
    config = loadConfig(repo);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }
  for (const stage of workflow.stages) {
    for (const job of stage.jobs ?? []) {
      if (typeof job.agent === "string" && !config.agents[job.agent]) {
        errors.push(`job ${job.id}: unknown agent "${job.agent}" in sigil.config.json`);
      }
    }
  }
}

function validateWorkflow(workflow: YamlWorkflow, errors: string[]): void {
  const stageIds = new Set<string>();
  const jobIds = new Set<string>();
  const priorStageOutputs = new Set<string>();
  const priorStageArtifacts = new Set<string>();

  for (const stage of workflow.stages) {
    if (stageIds.has(stage.id)) errors.push(`duplicate stage id: ${stage.id}`);
    stageIds.add(stage.id);

    if (stage.steps) {
      const stageStepIds = new Set<string>();
      const availableOutputs = new Set<string>(priorStageOutputs);
      const availableArtifacts = new Set<string>(priorStageArtifacts);
      for (const step of stage.steps) {
        if (stageStepIds.has(step.id)) errors.push(`stage ${stage.id}: duplicate step id ${step.id}`);
        stageStepIds.add(step.id);
        validateStepRefs(step, `stage ${stage.id}`, availableOutputs, availableArtifacts, errors);
        availableOutputs.add(`${stage.id}-steps.${step.id}`);
      }
      continue;
    }

    const stageOutputs = new Set<string>(priorStageOutputs);
    const stageArtifacts = new Set<string>(priorStageArtifacts);

    for (const job of stage.jobs ?? []) {
      if (jobIds.has(job.id)) errors.push(`duplicate job id: ${job.id}`);
      jobIds.add(job.id);
      validateJobKinds(job, errors);
      if (job.condition) {
        const issue = checkCondition(job.condition);
        if (issue) errors.push(`job ${job.id}: ${issue}`);
        for (const ref of collectRefs(job.condition)) {
          const outputMatch = ref.match(WORKFLOW_REF);
          if (outputMatch && !priorStageOutputs.has(`${outputMatch[1]}.${outputMatch[2]}`)) {
            errors.push(`job ${job.id}: unknown output reference ${ref}`);
          }
        }
      }

      const jobStepIds = new Set<string>();
      const availableOutputs = new Set<string>(priorStageOutputs);
      const availableArtifacts = new Set<string>(priorStageArtifacts);

      for (const step of job.steps) {
        if (jobStepIds.has(step.id)) errors.push(`job ${job.id}: duplicate step id ${step.id}`);
        jobStepIds.add(step.id);

        validateStepRefs(step, `job ${job.id}`, availableOutputs, availableArtifacts, errors);

        const kind = stepKind(step);
        if (["prompt", "eval", "run", "script", "sh"].includes(kind)) {
          availableOutputs.add(`${job.id}.${step.id}`);
          stageOutputs.add(`${job.id}.${step.id}`);
        }
        if (kind === "prompt" && "writes" in step && step.writes) {
          availableArtifacts.add(step.writes);
          stageArtifacts.add(step.writes);
        }
      }
    }

    for (const value of stageOutputs) priorStageOutputs.add(value);
    for (const value of stageArtifacts) priorStageArtifacts.add(value);
  }
}

export function parseYamlWorkflow(file: string): unknown {
  return YAML.parse(readFileSync(file, "utf8"));
}

export function validateYamlWorkflow(raw: unknown, repo?: string): YamlValidationResult {
  const parsed = YamlWorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      workflow: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    };
  }

  const errors: string[] = [];
  if (repo) validateAgentRefs(parsed.data, resolve(repo), errors);
  validateWorkflow(parsed.data, errors);
  return { workflow: parsed.data, errors };
}

export function validateYamlWorkflowFile(file: string, repo?: string): YamlValidationResult {
  return validateYamlWorkflow(parseYamlWorkflow(file), repo);
}
