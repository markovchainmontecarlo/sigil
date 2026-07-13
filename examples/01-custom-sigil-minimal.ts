import { z } from "zod";
import { sigil } from "sigil";

const Classification = z.object({
  kind: z.enum(["BUG", "FEATURE"]),
  rationale: z.string(),
});

export const triageIssue = sigil(
  "triage-issue",
  async (ctx, input: { repo: string; issue: string }) => {
    await using analyst = ctx.agent("reviewer");

    const summary = await analyst.prompt(
      `Read this issue and summarize the likely problem in one paragraph.\n\n${input.issue}`,
    );
    const classification = await analyst.prompt(
      "Classify the issue as BUG or FEATURE and explain the decision briefly.",
      Classification,
    );
    await analyst.prompt("Write a minimal reproduction script.", {
      writes: "repro.sh",
      minBytes: 1,
    });

    const gate = await ctx.evals("build");
    if (!gate.ok && !gate.skipped) ctx.issue(`build red: ${gate.log}`);

    return {
      summary,
      kind: classification.kind,
      rationale: classification.rationale,
      issues: ctx.issues,
      repro: ctx.artifacts.path("repro.sh"),
    };
  },
);
