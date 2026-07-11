import { publish, softwareChange } from "../src/index.js";

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

  const change = await softwareChange({ repo, intent });

  if (!change.valid || change.branch === undefined || change.prBody === undefined) {
    return {
      published: false,
      stage: change.stage,
      reason: "implementation was not clean enough to publish",
      change,
    };
  }

  const published = await publish(repo, {
    branch: change.branch,
    title: `${titlePrefix}: ${titleFromIntent(intent)}`,
    body: change.prBody,
    base,
  });

  return {
    published: published.pr?.ok === true,
    stage: "publish",
    change,
    delivery: published,
  };
}
