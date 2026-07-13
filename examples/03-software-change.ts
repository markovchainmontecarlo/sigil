import { softwareChange } from "sigil";

export async function buildChange(
  repo: string,
  intent: string,
  options: { brief?: string; outFile?: string } = {},
) {
  const result = await softwareChange({
    repo,
    intent,
    brief: options.brief,
    outFile: options.outFile,
  });

  return {
    ok: result.valid,
    stage: result.stage,
    taskFile: result.taskFile,
    taskCount: result.taskCount,
    branch: result.branch,
    reviewBlocking: result.reviewBlocking,
    failedTasks: result.failedTasks,
    noopTasks: result.noopTasks,
    prBody: result.prBody,
    issues: result.issues,
  };
}
