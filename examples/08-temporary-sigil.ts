import { sigil, type SigilContext } from "sigil";

export type TemporaryInvestigationInput = {
  repo: string;
  question: string;
  explorer?: string;
  reviewer?: string;
};

export type TemporaryInvestigationResult = {
  synthesis: string;
  artifacts: {
    architecture: string;
    risks: string;
    evidence: string;
    synthesis: string;
  };
  gate: Awaited<ReturnType<SigilContext["evals"]>>;
  issues: readonly string[];
};

export default sigil(
  "temporary-investigation",
  async (ctx, input: TemporaryInvestigationInput): Promise<TemporaryInvestigationResult> => {
    const explorer = input.explorer ?? "explorer";
    const reviewer = input.reviewer ?? "reviewer";
    const context = await ctx.renderContextBlock();

    const [architecture, risks, evidence] = await ctx.parallel([
      () => ctx.withAgent(explorer, (agent) => agent.prompt([
        "Analyze the architecture angle for this question.",
        context,
        `Question: ${input.question}`,
      ].filter(Boolean).join("\n\n"))),
      () => ctx.withAgent(reviewer, (agent) => agent.prompt([
        "Find risks, weak claims, and missing constraints for this question.",
        context,
        `Question: ${input.question}`,
      ].filter(Boolean).join("\n\n"))),
      () => ctx.withAgent(explorer, (agent) => agent.prompt([
        "Verify or falsify the key claims implied by this question. Cite repo evidence where possible.",
        context,
        `Question: ${input.question}`,
      ].filter(Boolean).join("\n\n"))),
    ]);

    const architecturePath = await ctx.artifacts.write("architecture.md", architecture);
    const risksPath = await ctx.artifacts.write("risks.md", risks);
    const evidencePath = await ctx.artifacts.write("evidence.md", evidence);

    const synthesis = await ctx.withAgent(reviewer, (agent) => agent.prompt([
      "Synthesize these independent reports into one useful answer.",
      "Preserve disagreement, name uncertainty, and end with the recommended next action.",
      `Question: ${input.question}`,
      `Architecture report:\n${architecture}`,
      `Risk report:\n${risks}`,
      `Evidence report:\n${evidence}`,
    ].join("\n\n")));
    const synthesisPath = await ctx.artifacts.write("synthesis.md", synthesis);

    const gate = await ctx.evals("verify");
    if (!gate.ok && !gate.skipped) ctx.issue(`verify gate red: ${gate.log}`);

    return {
      synthesis,
      artifacts: {
        architecture: architecturePath,
        risks: risksPath,
        evidence: evidencePath,
        synthesis: synthesisPath,
      },
      gate,
      issues: ctx.issues,
    };
  },
);
