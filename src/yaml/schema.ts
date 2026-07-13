import { z } from "zod";

import { AgentBindingSchema } from "../config.js";

const YamlAgentRefSchema = z.unknown().transform((value, context) => {
  if (typeof value === "string" && value.length > 0) return value;
  const binding = AgentBindingSchema.safeParse(value);
  if (binding.success) return binding.data;
  for (const issue of binding.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
  return z.NEVER;
});

const PromptOutputSchema = z.object({
  enum: z.array(z.string().min(1)).min(1).optional(),
});

const PromptStepSchema = z.object({
  id: z.string().min(1),
  condition: z.string().min(1).optional(),
  prompt: z.string().min(1),
  writes: z.string().min(1).optional(),
  minBytes: z.number().int().positive().optional(),
  output: PromptOutputSchema.optional(),
});

const EvalStepSchema = z.object({
  id: z.string().min(1),
  condition: z.string().min(1).optional(),
  eval: z.string().min(1),
});

const RunStepSchema = z.object({
  id: z.string().min(1),
  condition: z.string().min(1).optional(),
  run: z.object({
    workflow: z.enum(["software-change", "plan", "implement", "review", "breakdown", "dispatch"]),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
});

const ScriptStepSchema = z.object({
  id: z.string().min(1),
  condition: z.string().min(1).optional(),
  script: z.string().min(1).optional(),
  sh: z.string().min(1).optional(),
}).refine((value) => Boolean(value.script) !== Boolean(value.sh), {
  message: "script step must set exactly one of script or sh",
});

export const YamlStepSchema = z.union([
  PromptStepSchema,
  EvalStepSchema,
  RunStepSchema,
  ScriptStepSchema,
]);

export const YamlJobSchema = z.object({
  id: z.string().min(1),
  agent: YamlAgentRefSchema.optional(),
  condition: z.string().min(1).optional(),
  steps: z.array(YamlStepSchema).min(1),
});

export const YamlStageSchema = z.object({
  id: z.string().min(1),
  jobs: z.array(YamlJobSchema).min(1).optional(),
  steps: z.array(z.union([EvalStepSchema, RunStepSchema, ScriptStepSchema])).min(1).optional(),
}).refine((value) => Boolean(value.jobs) !== Boolean(value.steps), {
  message: "stage must declare exactly one of jobs or steps",
});

export const YamlWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  stages: z.array(YamlStageSchema).min(1),
});
