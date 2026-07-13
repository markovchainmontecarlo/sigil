import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../config.js";
import { parseYamlWorkflow, validateYamlWorkflow } from "./validate.js";
import type { YamlValidationResult, YamlWorkflow } from "./types.js";

function validateAgentReferences(workflow: YamlWorkflow, repo: string): string[] {
  const namedAgents = workflow.stages
    .flatMap((stage) => stage.jobs ?? [])
    .filter((job) => typeof job.agent === "string");
  if (namedAgents.length === 0) return [];

  try {
    const config = loadConfig(repo);
    return namedAgents
      .filter((job) => typeof job.agent === "string" && !config.agents[job.agent])
      .map((job) => `job ${job.id}: unknown agent "${String(job.agent)}" in sigil.config.json`);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function validateYamlWorkflowFile(file: string, repo?: string): YamlValidationResult {
  const validated = validateYamlWorkflow(parseYamlWorkflow(readFileSync(file, "utf8")));
  if (!repo || !validated.workflow) return validated;

  return {
    workflow: validated.workflow,
    errors: [...validated.errors, ...validateAgentReferences(validated.workflow, resolve(repo))],
  };
}
