import { sigil, softwareChange } from "../src/index.js";

export const buildIssueChange = sigil(
  "build-issue-change",
  async (ctx, input: { repo: string; issue: string; brief?: string }) => {
    const change = await ctx.run(softwareChange, {
      repo: input.repo,
      intent: input.issue,
      brief: input.brief,
    });

    return {
      ok: change.valid,
      stage: change.stage,
      taskFile: change.taskFile,
      branch: change.branch,
      reviewBlocking: change.reviewBlocking,
      failedTasks: change.failedTasks,
      noopTasks: change.noopTasks,
      prBody: change.prBody,
      issues: [...ctx.issues, ...change.issues],
    };
  },
);
