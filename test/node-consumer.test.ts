import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

test("the packed SDK works across Node worker and browser boundaries", () => {
  const build = Bun.spawnSync({
    cmd: ["bun", "run", "build"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--pack-destination", "/tmp", "--ignore-scripts", "--json"],
    cwd: join(process.cwd(), "dist", "package"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(pack.exitCode, pack.stderr.toString()).toBe(0);
  const [{ filename }] = JSON.parse(pack.stdout.toString()) as Array<{ filename: string }>;
  const tarball = join("/tmp", filename);

  const consumers = Bun.spawnSync({
    cmd: ["bun", "scripts/test-package-consumers.ts", tarball],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(consumers.exitCode, consumers.stderr.toString()).toBe(0);

  const reportPath = consumers.stdout.toString().trim().split("\n").at(-1)!;
  expect(existsSync(reportPath)).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  expect(report.node.normal.transitions).toEqual([
    "accepted",
    "queued",
    "acquired",
    "running",
    "terminal",
  ]);
  expect(report.node.normal.terminalCount).toBe(1);
  expect(report.node.normal.events).toEqual([[0, "started"], [1, "calculated"], [2, "succeeded"]]);
  expect(report.node.cancelled.status).toBe("cancelled");
  expect(report.node.cancelled.terminalCount).toBe(1);
  expect(report.node.cancelled.events).toEqual([[0, "started"], [1, "cancelled"]]);
  expect(report.node.sourceIsolated).toBe(true);
  expect(report.node.runtime).toBe("node");
  expect(report.examples.compiled).toBe(true);
  expect(report.browser).toEqual({ contracts: "accepted", root: "rejected", server: "rejected" });
}, 120_000);
