import { implement, plan, sigil } from "../src/index.js";

export const buildIssueChange = sigil(
  "build-issue-change",
  async (ctx, input: { repo: string; issue: string; brief?: string }) => {
    const planned = await ctx.run(plan, {
      repo: input.repo,
      intent: input.issue,
      brief: input.brief,
    });

    if (!planned.valid) {
      return {
        ok: false,
        stage: "plan",
        taskFile: planned.taskFile,
        issues: planned.issues,
      };
    }

    const implemented = await ctx.run(implement, {
      repo: input.repo,
      taskFile: planned.taskFile,
    });

    return {
      ok:
        !implemented.reviewBlocking &&
        implemented.failedTasks.length === 0 &&
        implemented.issues.length === 0,
      stage: "implement",
      taskFile: planned.taskFile,
      branch: implemented.branch,
      reviewBlocking: implemented.reviewBlocking,
      failedTasks: implemented.failedTasks,
      noopTasks: implemented.noopTasks,
      prBody: implemented.prBody,
      issues: [...ctx.issues, ...implemented.issues],
    };
  },
);
