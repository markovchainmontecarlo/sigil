const FAILURE_LINE = /\b(fail(ed|ure|ing)?|error|exception|abort(ed)?|exited? with|non-zero|timed? ?out)\b|✗|✖/i;
const FALSE_POSITIVE = /\(pass\)|\b0 fail\b|\b0 errors?\b|--max-warnings/;

/** True when the line indicates a failure rather than echoing failure vocabulary. */
export function isFailureLine(line: string): boolean {
  return FAILURE_LINE.test(line) && !FALSE_POSITIVE.test(line);
}

/** Compress `log` to at most `cap` characters without losing the failure signal. */
export function extractFailureLog(log: string, cap = 20000, context = 3): string {
  if (log.length <= cap) return log;
  const lines = log.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isFailureLine(lines[i])) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  }
  const failureBudget = Math.floor(cap / 2);
  const sections: string[] = [];
  let used = 0;
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const chunk = (i !== prev + 1 ? "  [...]\n" : "") + lines[i] + "\n";
    if (used + chunk.length > failureBudget) {
      sections.push("  [... further failure lines truncated ...]\n");
      break;
    }
    sections.push(chunk);
    used += chunk.length;
    prev = i;
  }
  const failureSection = sections.length > 0 ? `=== failure lines (extracted) ===\n${sections.join("")}\n=== log tail ===\n` : "";
  return failureSection + log.slice(-(cap - failureSection.length));
}
