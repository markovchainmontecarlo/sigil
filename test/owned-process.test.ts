import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { OwnedProcess, type OwnedProcessInfo } from "../src/owned-process.js";
import {
  processIdentityIsAlive,
  readProcessIdentity,
  type ProcessIdentity,
} from "../src/process-identity.js";

function childScript(source: string): { directory: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "sigil-owned-process-"));
  const script = join(directory, "child.mjs");
  writeFileSync(script, source);
  return { directory, script };
}

async function waitForIdentity(path: string): Promise<ProcessIdentity> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number(readFileSync(path, "utf8"));
      if (pid) return readProcessIdentity(pid);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("descendant identity was not published");
}

describe("owned process groups", () => {
  test("captures an immediate successful exit", async () => {
    await using owned = await OwnedProcess.spawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      kind: "gate",
    });

    const result = await owned.wait();

    expect(result.exitCode).toBe(0);
    expect(await processIdentityIsAlive(owned.identity)).toBe(false);
  });

  test("cancellation settles after the child and descendant are gone", async () => {
    const fixture = childScript(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.DESCENDANT_FILE, String(descendant.pid));
      setInterval(() => {}, 1000);
    `);
    const descendantFile = join(fixture.directory, "descendant.pid");
    const abort = new AbortController();
    await using owned = await OwnedProcess.spawn({
      command: process.execPath,
      args: [fixture.script],
      env: { ...process.env, DESCENDANT_FILE: descendantFile },
      kind: "shell",
      signal: abort.signal,
    });
    const descendant = await waitForIdentity(descendantFile);

    abort.abort();
    await owned.wait();

    expect(await processIdentityIsAlive(owned.identity)).toBe(false);
    expect(await processIdentityIsAlive(descendant)).toBe(false);
  });

  test("escalates TERM-resistant groups and disposal is idempotent", async () => {
    const fixture = childScript(`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const owned = await OwnedProcess.spawn({
      command: process.execPath,
      args: [fixture.script],
      kind: "shell",
      terminationTimeoutMs: 30,
    });

    await owned.dispose();
    await owned.dispose();

    expect(await processIdentityIsAlive(owned.identity)).toBe(false);
  });

  test("publishes and removes one identity-matched lifecycle record", async () => {
    const active = new Map<number, OwnedProcessInfo>();
    await using owned = await OwnedProcess.spawn({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 20)"],
      kind: "gate",
      lifecycle: {
        started(process) { active.set(process.identity.pid, process); },
        stopped(process) { active.delete(process.identity.pid); },
      },
    });

    expect(active.get(owned.identity.pid)?.identity).toEqual(owned.identity);
    await owned.wait();
    expect(active.has(owned.identity.pid)).toBe(false);
  });

  test("waits for descendants after the group leader exits", async () => {
    const fixture = childScript(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.DESCENDANT_FILE, String(descendant.pid));
      process.exit(0);
    `);
    const descendantFile = join(fixture.directory, "descendant.pid");
    await using owned = await OwnedProcess.spawn({
      command: process.execPath,
      args: [fixture.script],
      env: { ...process.env, DESCENDANT_FILE: descendantFile },
      kind: "shell",
      terminationTimeoutMs: 100,
    });
    const descendant = await waitForIdentity(descendantFile);

    await owned.wait();

    expect(await processIdentityIsAlive(descendant)).toBe(false);
  });
});
