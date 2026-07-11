import { describe, expect, test } from "bun:test";
import { extractFailureLog } from "../src/reports/failure-log.js";
import { diffFailures, parseFailingTests } from "../src/reports/junit.js";

describe("junit reports", () => {
  test("parseFailingTests returns classname.name only for failure and error testcases", () => {
    const report = `
      <testsuite>
        <testcase classname="TodoTest" name="passes" />
        <testcase classname="TodoTest" name="fails"><failure message="bad" /></testcase>
        <testcase classname="ApiTest" name="errors"><error>boom</error></testcase>
        <testcase name="plain"><failure /></testcase>
      </testsuite>
    `;

    expect([...parseFailingTests(report, "junit")].sort()).toEqual(["ApiTest.errors", "TodoTest.fails", "plain"]);
  });

  test("diffFailures returns only newly failing ids", () => {
    const baseline = new Set(["TodoTest.fails"]);
    const current = new Set(["TodoTest.fails", "ApiTest.errors"]);

    expect([...diffFailures(baseline, current)]).toEqual(["ApiTest.errors"]);
  });
});

describe("failure log compression", () => {
  test("extractFailureLog keeps failure lines within the cap", () => {
    const log = `${"setup ok\n".repeat(80)}ERROR build exploded\nstack frame\n${"tail ok\n".repeat(80)}`;
    const compressed = extractFailureLog(log, 300, 0);

    expect(compressed.length).toBeLessThanOrEqual(300);
    expect(compressed).toContain("ERROR build exploded");
    expect(compressed).toContain("=== failure lines (extracted) ===");
  });
});
