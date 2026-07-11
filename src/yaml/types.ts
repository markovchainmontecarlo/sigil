import type { AgentBinding } from "../config.js";

export type YamlAgentRef = string | AgentBinding;

export type YamlPromptOutput = {
  enum?: string[];
};

export type YamlPromptStep = {
  id: string;
  condition?: string;
  prompt: string;
  writes?: string;
  minBytes?: number;
  output?: YamlPromptOutput;
};

export type YamlEvalStep = {
  id: string;
  condition?: string;
  eval: string;
};

export type YamlRunStep = {
  id: string;
  condition?: string;
  run: {
    workflow: "software-change" | "plan" | "implement" | "review" | "breakdown" | "dispatch";
    input?: Record<string, unknown>;
  };
};

export type YamlScriptStep = {
  id: string;
  condition?: string;
  script?: string;
  sh?: string;
};

export type YamlAgentStep = YamlPromptStep | YamlEvalStep | YamlRunStep;
export type YamlDeterministicStep = YamlEvalStep | YamlRunStep | YamlScriptStep;
export type YamlStep = YamlAgentStep | YamlDeterministicStep;

export type YamlJob = {
  id: string;
  agent?: YamlAgentRef;
  condition?: string;
  steps: YamlStep[];
};

export type YamlStage = {
  id: string;
  jobs?: YamlJob[];
  steps?: YamlDeterministicStep[];
};

export type YamlWorkflow = {
  name: string;
  description?: string;
  stages: YamlStage[];
};

export type CompiledYamlAgentJob = {
  kind: "agent-job";
  id: string;
  condition?: string;
  agent: YamlAgentRef;
  steps: YamlAgentStep[];
};

export type CompiledYamlDeterministicJob = {
  kind: "deterministic-job";
  id: string;
  condition?: string;
  steps: YamlDeterministicStep[];
};

export type CompiledYamlStage = {
  id: string;
  jobs: Array<CompiledYamlAgentJob | CompiledYamlDeterministicJob>;
};

export type CompiledYamlWorkflow = {
  name: string;
  description?: string;
  stages: CompiledYamlStage[];
};

export type YamlValidationResult = {
  workflow: YamlWorkflow | null;
  errors: string[];
};

export type YamlRunResult = {
  workflow: string;
  stageResults: Array<{
    id: string;
    jobResults: Array<{
      id: string;
      skipped: boolean;
      stepResults: Array<{ id: string; kind: string; skipped: boolean; output?: unknown }>;
    }>;
  }>;
  issues: string[];
  artifacts: Record<string, string>;
};
