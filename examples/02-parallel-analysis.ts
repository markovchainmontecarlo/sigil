import { z } from "zod";
import { sigil } from "../src/index.js";

const AnalysisReport = z.object({
  summary: z.string(),
  signal: z.string(),
});

export const analyzeChange = sigil(
  "analyze-change",
  async (ctx, input: { repo: string; diff: string }) => {
    const [risk, tests] = await ctx.parallel([
      async () => {
        await using reviewer = ctx.agent("reviewer");
        return reviewer.prompt(
          `Review this diff for product and code risk.\n\n${input.diff}`,
          AnalysisReport,
        );
      },
      async () => {
        await using tester = ctx.agent("reviewer");
        return tester.prompt(
          `Review this diff for missing tests.\n\n${input.diff}`,
          AnalysisReport,
        );
      },
    ]);

    await using synthesizer = ctx.agent("reviewer");
    const recommendation = await synthesizer.prompt(
      [
        `Risk signal: ${risk.signal}`,
        risk.summary,
        `Test signal: ${tests.signal}`,
        tests.summary,
        "Write one paragraph explaining whether this change is ready for implementation.",
      ].join("\n\n"),
    );

    return { risk, tests, recommendation, issues: ctx.issues };
  },
);
