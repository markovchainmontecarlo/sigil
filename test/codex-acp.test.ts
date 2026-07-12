import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { OwnedCodexAcpConnection } from "../src/codex-acp.js";
import { processIdentityIsAlive, readProcessIdentity } from "../src/process-identity.js";

function fakeAcpServer(directory: string): string {
  const script = join(directory, "fake-acp.mjs");
  writeFileSync(script, `
    import fs from "node:fs";
    import readline from "node:readline";
    const methods = [];
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", line => {
      const request = JSON.parse(line);
      methods.push(request.method);
      fs.writeFileSync(process.env.METHODS_FILE, JSON.stringify(methods));
      if (request.method === "initialize") {
        reply(request.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] });
      } else if (request.method === "session/new") {
        reply(request.id, { sessionId: "new-session" });
      } else if (request.method === "session/resume") {
        reply(request.id, {});
      } else if (request.method === "session/set_model") {
        reply(request.id, {});
      } else if (request.method === "session/prompt") {
        notify({ sessionId: request.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
        notify({ sessionId: request.params.sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 200000 } });
        reply(request.id, { stopReason: "end_turn" });
      }
    });
    function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
    function notify(params) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\\n"); }
  `);
  return script;
}

describe("owned Codex ACP connection", () => {
  test("exposes child identity, session identity, usage updates, and resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-owned-acp-"));
    const methodsFile = join(directory, "methods.json");
    const script = fakeAcpServer(directory);
    let startedPid: number | undefined;
    let stoppedPid: number | undefined;
    const connection = new OwnedCodexAcpConnection({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: { METHODS_FILE: methodsFile },
      resumeSessionId: "existing-session",
      onProcessStarted(identity) { startedPid = identity.pid; },
      onProcessStopped(identity) { stoppedPid = identity.pid; },
    });
    const events = [];

    for await (const event of connection.promptStream("continue")) events.push(event);

    expect(startedPid).toBeNumber();
    expect(connection.childIdentity?.pid).toBe(startedPid);
    expect(connection.sessionId).toBe("existing-session");
    expect(events).toContainEqual({ type: "text", text: "done" });
    expect(events).toContainEqual({
      type: "session-update",
      update: { sessionUpdate: "usage_update", used: 12, size: 200000 },
    });
    const methods = JSON.parse(readFileSync(methodsFile, "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/set_model");
    const identity = connection.childIdentity!;
    await connection.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await processIdentityIsAlive(identity)).toBe(false);
    expect(stoppedPid).toBe(startedPid);
    await connection.disconnect();
  });

  test("aborting a non-settling prompt removes descendants before rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sigil-abort-acp-"));
    const descendantFile = join(directory, "descendant.pid");
    const script = join(directory, "hanging-acp.mjs");
    writeFileSync(script, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import readline from "node:readline";
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", line => {
        const request = JSON.parse(line);
        if (request.method === "initialize") reply(request.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        if (request.method === "session/new") reply(request.id, { sessionId: "hanging-session" });
        if (request.method === "session/prompt") {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          writeFileSync(process.env.DESCENDANT_FILE, String(child.pid));
        }
      });
      function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
    `);
    const connection = new OwnedCodexAcpConnection({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: { DESCENDANT_FILE: descendantFile },
    });
    const abort = new AbortController();
    const prompting = async () => {
      for await (const _event of connection.promptStream("wait", abort.signal)) {}
    };
    const result = prompting();
    while (!existsSync(descendantFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    const descendant = await readProcessIdentity(Number(readFileSync(descendantFile, "utf8")));

    abort.abort(new Error("cancel prompt"));
    await expect(result).rejects.toThrow("cancel prompt");

    expect(await processIdentityIsAlive(descendant)).toBe(false);
    await connection.disconnect();
  });
});
