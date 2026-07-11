import { implement, plan } from "../src/index.js";

export async function buildChange(
  repo: string,
  intent: string,
  options: { brief?: string; outFile?: string } = {},
) {
  const planned = await plan({
    repo,
    intent,
    brief: options.brief,
    outFile: options.outFile,
  });
  if (!planned.valid) {
    return {
      ok: false,
      stage: "plan",
      taskFile: planned.taskFile,
      issues: planned.issues,
    };
  }

  const implemented = await implement({ repo, taskFile: planned.taskFile });
  const clean =
    !implemented.reviewBlocking &&
    implemented.failedTasks.length === 0 &&
    implemented.issues.length === 0;

  return {
    ok: clean,
    stage: clean ? "done" : "implement",
    taskFile: planned.taskFile,
    taskCount: planned.taskCount,
    branch: implemented.branch,
    reviewBlocking: implemented.reviewBlocking,
    failedTasks: implemented.failedTasks,
    noopTasks: implemented.noopTasks,
    prBody: implemented.prBody,
    issues: implemented.issues,
  };
}
