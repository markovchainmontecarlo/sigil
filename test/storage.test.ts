import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { assertDurablePath, isTemporaryPath } from "../src/storage.js";

describe("run storage policy", () => {
  test("recognizes operating-system temporary directories and descendants", () => {
    expect(isTemporaryPath(tmpdir())).toBe(true);
    expect(isTemporaryPath(join(tmpdir(), "sigil", "run"))).toBe(true);
    expect(isTemporaryPath("/tmp/sigil/run")).toBe(true);
    expect(isTemporaryPath("/private/tmp/sigil/run")).toBe(true);
  });

  test("accepts durable repository and user workspace paths", () => {
    const durable = join(homedir(), ".sigil", "runs", "fixture");

    expect(isTemporaryPath(durable)).toBe(false);
    expect(() => assertDurablePath({ label: "run directory", path: durable })).not.toThrow();
  });

  test("recognizes a symlink into temporary storage", () => {
    const root = mkdtempSync(join(homedir(), ".sigil-storage-test-"));
    const temporary = mkdtempSync(join(tmpdir(), "sigil-storage-target-"));
    const link = join(root, "temporary-link");
    symlinkSync(temporary, link);

    expect(isTemporaryPath(join(link, "future-run"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  });

  test("fails with a corrective durable-storage message", () => {
    expect(() => assertDurablePath({
      label: "workflow file",
      path: join(tmpdir(), "workflow.ts"),
    })).toThrow("durable run refused: workflow file is under temporary storage");
  });
});
