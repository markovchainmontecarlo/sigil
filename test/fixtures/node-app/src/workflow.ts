import { sigil } from "sigil";

export const fixtureWorkflow = sigil(
  "fixture-workflow",
  async (context, input: { repo: string; value: number }) => {
    await context.observe("calculated", { value: input.value });
    await context.artifacts.write("result.txt", String(input.value * 2));
    return { doubled: input.value * 2 };
  },
);
