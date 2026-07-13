import { loadPromptTemplate } from "../../prompts.js";

export function migrationPrompt(
  name:
    | "review-architecture"
    | "review-behavior"
    | "repair-final"
    | "repair-protected-paths",
  variables: Record<string, string>,
): string {
  return loadPromptTemplate(`workflows/migrate/prompts/${name}.md`, variables);
}
