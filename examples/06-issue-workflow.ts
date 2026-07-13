import { z } from "zod";
import { sigil, softwareChange } from "sigil";

const IssueKind = z.object({
  kind: z.enum(["BUG", "FEATURE"]),
  rationale: z.string(),
});

export const resolveIssue = sigil(
  "resolve-issue",
  async (ctx, input: { repo: string; issue: string }) => {
    await using analyst = ctx.agent("reviewer");

    await analyst.prompt(`Read this issue and identify the user-visible problem.\n\n${input.issue}`);
    const classification = await analyst.prompt(
      "Classify the issue as BUG or FEATURE and explain the decision briefly.",
      IssueKind,
    );
    const reproduction = await analyst.prompt(
      "Write a minimal reproduction or acceptance script for the issue.",
      { writes: "issue/repro.sh", minBytes: 1 },
    );

    const [risk, testPlan] = await ctx.parallel([
      async () => {
        await using reviewer = ctx.agent("reviewer");
        return reviewer.prompt(`Review the likely implementation risk.\n\n${classification.rationale}`);
      },
      async () => {
        await using tester = ctx.agent("reviewer");
        return tester.prompt(`Draft a focused test plan using this artifact.\n\n${reproduction}`);
      },
    ]);

    const gate = await ctx.evals("build");
    if (!gate.ok && !gate.skipped) ctx.issue(`build red before implementation: ${gate.log}`);

    if (classification.kind === "FEATURE") {
      return {
        kind: classification.kind,
        risk,
        testPlan,
        reproduction: ctx.artifacts.path("issue/repro.sh"),
        issues: ctx.issues,
      };
    }

    const change = await ctx.run(softwareChange, {
      repo: input.repo,
      intent: `${input.issue}\n\nRisk:\n${risk}\n\nTest plan:\n${testPlan}`,
    });

    return {
      kind: classification.kind,
      change,
      reproduction: ctx.artifacts.path("issue/repro.sh"),
      issues: ctx.issues,
    };
  },
);
