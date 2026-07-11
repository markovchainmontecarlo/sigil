import { loadConfig, type AgentBinding } from "../config.js";
import type {
  CompiledYamlAgentJob,
  CompiledYamlDeterministicJob,
  CompiledYamlStage,
  CompiledYamlWorkflow,
  YamlAgentStep,
  YamlAgentRef,
  YamlDeterministicStep,
  YamlJob,
  YamlWorkflow,
} from "./types.js";

function resolveAgentRef(agent: YamlAgentRef, repo: string): AgentBinding | string {
  if (typeof agent === "string") {
    loadConfig(repo);
    return agent;
  }
  return agent;
}

function compileJob(job: YamlJob, repo: string): CompiledYamlAgentJob | CompiledYamlDeterministicJob {
  if (job.agent !== undefined) {
    return {
      kind: "agent-job",
      id: job.id,
      condition: job.condition,
      agent: resolveAgentRef(job.agent, repo),
      steps: job.steps as YamlAgentStep[],
    };
  }

  return {
    kind: "deterministic-job",
    id: job.id,
    condition: job.condition,
    steps: job.steps as YamlDeterministicStep[],
  };
}

function compileStage(stage: YamlWorkflow["stages"][number], repo: string): CompiledYamlStage {
  if (stage.jobs) {
    return {
      id: stage.id,
      jobs: stage.jobs.map((job) => compileJob(job, repo)),
    };
  }

  return {
    id: stage.id,
    jobs: [
      {
        kind: "deterministic-job",
        id: `${stage.id}-steps`,
        steps: stage.steps ?? [],
      },
    ],
  };
}

export function compileYamlWorkflow(workflow: YamlWorkflow, repo: string): CompiledYamlWorkflow {
  return {
    name: workflow.name,
    description: workflow.description,
    stages: workflow.stages.map((stage) => compileStage(stage, repo)),
  };
}
