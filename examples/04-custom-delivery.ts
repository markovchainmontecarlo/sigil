import { implement, plan, publish } from "../src/index.js";

function titleFromIntent(intent: string): string {
  const firstLine = intent.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "sigil change";
  return firstLine.trim();
}

export async function shipWhenClean(
  repo: string,
  intent: string,
  options: { base?: string; titlePrefix?: string } = {},
) {
  const base = options.base ?? "main";
  const titlePrefix = options.titlePrefix ?? "sigil";

  const planned = await plan({ repo, intent });
  if (!planned.valid) {
    return { published: false, stage: "plan", issues: planned.issues };
  }

  const implemented = await implement({ repo, taskFile: planned.taskFile });
  const shouldPublish =
    !implemented.reviewBlocking &&
    implemented.failedTasks.length === 0 &&
    implemented.issues.length === 0;

  if (!shouldPublish) {
    return {
      published: false,
      stage: "implement",
      reason: "implementation was not clean enough to publish",
      implemented,
    };
  }

  const published = await publish(repo, {
    branch: implemented.branch,
    title: `${titlePrefix}: ${titleFromIntent(intent)}`,
    body: implemented.prBody,
    base,
  });

  return {
    published: published.pr?.ok === true,
    stage: "publish",
    implemented,
    delivery: published,
  };
}
