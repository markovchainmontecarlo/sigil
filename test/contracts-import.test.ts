import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

test("contracts import evaluates only contract modules", () => {
  const directory = mkdtempSync(join(tmpdir(), "sigil-contract-import-"));
  const log = join(directory, "modules.log");
  const loader = join(directory, "loader.mjs");
  writeFileSync(log, "");
  writeFileSync(loader, `
    import { appendFileSync } from "node:fs";
    export async function load(url, context, nextLoad) {
      if (url.includes("/dist/package/src/")) appendFileSync(${JSON.stringify(log)}, url + "\\n");
      return nextLoad(url, context);
    }
  `);

  const result = Bun.spawnSync({
    cmd: [
      "node",
      "--experimental-loader",
      loader,
      "--input-type=module",
      "-e",
      'import("sigil/contracts")',
    ],
    cwd: join(process.cwd(), "dist", "package"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);

  const modules = readFileSync(log, "utf8");
  expect(modules).not.toMatch(/(?:agents|provider|git|process|workflow|yaml\/compile|yaml\/run|config)\.js/);
  expect(modules).not.toContain("node:child_process");
});
