export type TestReportFormat = "junit";

const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const attributePattern = /(\w+)=("([^"]*)"|'([^']*)')/g;

function readAttribute(attrs: string, name: string): string | undefined {
  for (const match of attrs.matchAll(attributePattern)) {
    const attrName = match[1];
    const attrValue = match[3] ?? match[4] ?? "";
    if (attrName === name) return attrValue;
  }
  return undefined;
}

function hasFailure(body: string | undefined): boolean {
  if (!body) return false;
  return /<(failure|error)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/\1>)/.test(body);
}

function toTestIdentifier(classname: string | undefined, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return classname ? `${classname}.${name}` : name;
}

export function parseFailingTests(raw: string, format: TestReportFormat): Set<string> {
  if (format !== "junit") throw new Error(`unsupported test report format: ${format}`);
  const failures = new Set<string>();
  for (const match of raw.matchAll(testcasePattern)) {
    const attrs = match[1] ?? "";
    const body = match[2];
    if (!hasFailure(body)) continue;
    const id = toTestIdentifier(readAttribute(attrs, "classname"), readAttribute(attrs, "name"));
    if (id) failures.add(id);
  }
  return failures;
}

export function diffFailures(baseline: ReadonlySet<string>, current: ReadonlySet<string>): Set<string> {
  const regressions = new Set<string>();
  for (const failure of current) if (!baseline.has(failure)) regressions.add(failure);
  return regressions;
}
