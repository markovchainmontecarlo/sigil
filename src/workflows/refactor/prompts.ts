import { loadPromptTemplate } from "../../prompts.js";

export type RefactorPromptName =
  | "analyze-structure"
  | "analyze-risk"
  | "synthesize-plan"
  | "implement-slice"
  | "repair-slice"
  | "repair-protected-paths"
  | "review-structure"
  | "review-behavior"
  | "repair-review";

export function refactorPrompt(
  name: RefactorPromptName,
  variables: Record<string, string>,
): string {
  return loadPromptTemplate(`src/workflows/refactor/prompts/${name}.md`, variables);
}
