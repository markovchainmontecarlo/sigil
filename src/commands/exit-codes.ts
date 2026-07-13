import type { PublishResult } from "../git.js";
import type { ImplementResult } from "../workflows/software-change/implementation/index.js";
import type { ReviewResult } from "../workflows/software-change/review/index.js";
import type { SoftwareChangeResult } from "../workflows/software-change/workflow.js";

export function implementExitCode(
  result: Pick<ImplementResult, "reviewBlocking" | "failedTasks" | "issues">,
  published: PublishResult | null,
  publicationRequested = true,
): 0 | 1 {
  const implemented = !result.reviewBlocking
    && result.failedTasks.length === 0
    && result.issues.length === 0;
  const delivered = !publicationRequested || published?.pr?.ok === true;
  return implemented && delivered ? 0 : 1;
}

export function reviewExitCode(result: Pick<ReviewResult, "valid" | "unresolvedHigh" | "issues">): 0 | 1 {
  return result.valid && result.unresolvedHigh === 0 && result.issues.length === 0 ? 0 : 1;
}

export function softwareChangeExitCode(result: Pick<SoftwareChangeResult, "valid" | "issues">): 0 | 1 {
  return result.valid && result.issues.length === 0 ? 0 : 1;
}
