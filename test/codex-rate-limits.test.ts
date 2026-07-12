import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { readCodexAccountStatus } from "../src/codex-rate-limits.js";
import type { CodexProfile } from "../src/codex-profiles.js";

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
  return () => spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
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
    expect(status.capacity.remainingPercentage).toBe(65);
  });

  test("bounds a non-responsive profile", async () => {
    const spawnAppServer = appServer("setInterval(() => {}, 1000);");
    const started = Date.now();

    await expect(readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 30 }))
      .rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("rejects pending requests when the child exits", async () => {
    const spawnAppServer = appServer("process.exit(7);");

    await expect(readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 }))
      .rejects.toThrow("exited before completing");
  });

  test("rejects JSON-RPC errors", async () => {
    const spawnAppServer = appServer(`
      process.stdin.once("data", data => {
        const request = JSON.parse(String(data));
        process.stdout.write(JSON.stringify({ id: request.id, error: { code: -1, message: "bad profile" } }) + "\\n");
      });
    `);

    await expect(readCodexAccountStatus(profile, { spawnAppServer, timeoutMs: 500 }))
      .rejects.toThrow("bad profile");
  });
});
