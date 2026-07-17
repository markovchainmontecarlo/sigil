import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { readCodexAccountStatus } from "../src/codex-rate-limits.js";
import type { CodexProfile } from "../src/codex-profiles.js";
import { processIdentityIsAlive, readProcessIdentity } from "../src/process-identity.js";

const profile: CodexProfile = {
  name: "test",
  home: "/unused",
  enabled: true,
  profileClass: "subscription",
};

function appServer(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sigil-app-server-"));
  const script = join(directory, "server.mjs");
  writeFileSync(script, source);
  return () => spawn(process.execPath, [script], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("Codex app-server capacity reads", () => {
  test("reads account classification and a subscription window", async () => {
    const spawnAppServer = appServer(`
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", line => {
        const request = JSON.parse(line);
        const result = request.method === "account/read"
          ? { account: { type: "chatgpt" } }
          : request.method === "account/rateLimits/read"
            ? { rateLimits: { primary: { usedPercent: 35 } } }
            : {};
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `);

    const status = await readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 });

    expect(status.profileClass).toBe("subscription");
    expect(status.capacity.kind).toBe("available");
    expect(status.capacity.kind === "available" && status.capacity.remainingPercentage).toBe(65);
  });

  test("bounds a non-responsive profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-capacity-descendant-"));
    const pidFile = join(directory, "descendant.pid");
    const spawnAppServer = appServer(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();

    const reading = readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 });
    await waitUntil(() => existsSync(pidFile), "capacity descendant identity");
    const descendant = await readProcessIdentity(Number(readFileSync(pidFile, "utf8")));

    await expect(reading).resolves.toMatchObject({ capacity: { kind: "unknown" } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await processIdentityIsAlive(descendant)).toBe(false);
  });

  test("rejects pending requests when the child exits", async () => {
    const spawnAppServer = appServer("process.exit(7);");

    await expect(readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 }))
      .resolves.toMatchObject({ capacity: { kind: "unknown" } });
  });

  test("rejects JSON-RPC errors", async () => {
    const spawnAppServer = appServer(`
      process.stdin.once("data", data => {
        const request = JSON.parse(String(data));
        process.stdout.write(JSON.stringify({ id: request.id, error: { code: -1, message: "bad profile" } }) + "\\n");
      });
    `);

    await expect(readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 }))
      .resolves.toMatchObject({ capacity: { kind: "unknown", message: expect.stringContaining("bad profile") } });
  });
});

async function waitUntil(condition: () => boolean, subject: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${subject}`);
    await Bun.sleep(10);
  }
}
