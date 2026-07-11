import { loadPromptTemplate } from "../../prompts.js";

export type ProbePromptName = "design" | "findings" | "buildTaskGraph";

export function probePrompt(name: ProbePromptName, variables: Record<string, unknown> = {}): string {
  return loadPromptTemplate(`src/workflows/probe/prompts/${name}.md`, variables);
}

export const probePrompts = {
  design: (variables: Record<string, unknown> = {}) => probePrompt("design", variables),
  findings: (variables: Record<string, unknown> = {}) => probePrompt("findings", variables),
  buildTaskGraph: (variables: Record<string, unknown> = {}) => probePrompt("buildTaskGraph", variables),
};
