import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const router = () => readFileSync("skills/sigil/SKILL.md", "utf8");
const briefReference = () => readFileSync("skills/sigil/references/brief.md", "utf8");
const taskGraphReference = () => readFileSync("skills/sigil/references/task-graph.md", "utf8");

describe("Sigil assistant intake", () => {
  test("checks repository setup before planning or implementation", () => {
    const skill = router();

    expect(skill).toContain("Review the setup report");
    expect(skill).toContain("build or test eval");
    expect(skill).toContain("Before starting agent work");
  });

  test("requires one structured brief before planning or implementation", () => {
    const skill = router();
    const brief = briefReference();

    expect(skill).toContain("write `brief.md`");
    expect(skill).toContain("show its complete contents");
    expect(skill).toContain("wait for confirmation or correction");
    for (const heading of [
      "Intent",
      "Acceptance criteria",
      "Decisions",
      "Architecture",
      "Repository context",
      "Claims to verify",
      "Constraints",
      "Non-goals",
      "References",
    ]) {
      expect(brief).toContain(`## ${heading}`);
    }
  });

  test("offers only the two relevant routes for an accepted Markdown plan", () => {
    const skill = router();

    expect(skill).toContain("Replan and implement");
    expect(skill).toContain("Convert and implement locally");
    expect(skill).toContain("Do not infer this choice");
  });

  test("routes existing changes to the real review workflow with explicit effects", () => {
    const skill = router();

    expect(skill).toContain("run `review` with `autofix: false`");
    expect(skill).toContain("run `review` with `autofix: true`");
    expect(skill).toContain("There is no separate review skill");
  });

  test("ships installed references for direct task-graph conversion", () => {
    const reference = taskGraphReference();
    const metadata = readFileSync("skills/sigil/agents/openai.yaml", "utf8");

    expect(reference).toContain("docs/reference/task-graph.md");
    expect(reference).toContain("validate");
    expect(reference).toContain("implement");
    expect(metadata).toContain("confirmed structured brief");
    expect(metadata).toContain("local implementation");
  });
});
