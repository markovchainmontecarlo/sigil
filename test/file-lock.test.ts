import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { acquireFileLock } from "../src/file-lock.js";

describe("bounded file locks", () => {
  test("waits for a normal concurrent owner instead of failing fast", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "sigil-lock-")), "lock");
    const first = await acquireFileLock(lockDir);
    const second = acquireFileLock(lockDir, { timeoutMs: 1_000, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first[Symbol.asyncDispose]();
    await using _next = await second;

    expect(_next).toBeDefined();
  });

  test("recovers a stale owner with a dead process identity", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "sigil-lock-")), "lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      pid: 999_999,
      startIdentity: "not-running",
      acquiredAt: new Date().toISOString(),
    }));

    await using lock = await acquireFileLock(lockDir, { timeoutMs: 500, pollMs: 5 });

    expect(lock).toBeDefined();
  });
});
