import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { LazySigilAgent, type SigilAgent } from "../src/agent.js";

function fakeAgent(): SigilAgent {
  return {
    prompt: async (text: string) => text,
    close: async () => {},
    async [Symbol.asyncDispose]() { await this.close(); },
  };
}

test("lazy agent initializes once across concurrent first operations", async () => {
  let initialized = 0;
  const lazy = new LazySigilAgent(async () => {
    initialized += 1;
    await Bun.sleep(5);
    return fakeAgent();
  }, { provider: "codex" });

  expect(await Promise.all([lazy.prompt("one"), lazy.prompt("two")])).toEqual(["one", "two"]);
  expect(initialized).toBe(1);
  expect(await lazy.prompt("three")).toBe("three");
  expect(initialized).toBe(1);
});

test("closing an unused lazy agent does not initialize it", async () => {
  let initialized = 0;
  const lazy = new LazySigilAgent(async () => {
    initialized += 1;
    return fakeAgent();
  });

  await lazy.close();

  expect(initialized).toBe(0);
  await expect(lazy.prompt("closed")).rejects.toThrow("agent is closed");
});

test("Node imports and constructs without evaluating provider adapters", () => {
  expect(Bun.spawnSync({ cmd: ["bun", "run", "build"], stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
  const directory = mkdtempSync(join(tmpdir(), "sigil-provider-loading-"));
  const log = join(directory, "modules.log");
  const loader = join(directory, "loader.mjs");
  writeFileSync(log, "");
  writeFileSync(loader, `import { appendFileSync } from "node:fs"; export async function load(url, context, next) { if (url.includes("/dist/package/src/")) appendFileSync(${JSON.stringify(log)}, url + "\\n"); return next(url, context); }`);
  const result = Bun.spawnSync({
    cmd: ["node", "--experimental-loader", loader, "--input-type=module", "-e", 'const { agent } = await import("sigil"); const unused = agent({ provider: "codex", model: "test" }); await unused.close();'],
    cwd: join(process.cwd(), "dist", "package"),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(log, "utf8")).not.toMatch(/\/providers\/(?:codex|claude|copilot)\.js|claude-pty\.js|owned-pty-process\.js/);
}, 30_000);
