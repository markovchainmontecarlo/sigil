import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { readDispatchRuntime, writeDispatchRuntime } from "../src/workflows/dispatch/state.js";

describe("dispatch runtime", () => {
  test("round-trips only recovery-authoritative identity", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "dispatch-runtime-")), "runtime.json");
    const runtime = { version: 1 as const, binding: "coder", providerSessionId: "session", active: true };
    await writeDispatchRuntime(file, runtime);
    expect(await readDispatchRuntime(file)).toEqual(runtime);
  });

  test("rejects telemetry-bearing records", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "dispatch-runtime-")), "runtime.json");
    writeFileSync(file, JSON.stringify({ version: 1, binding: "coder", active: true, profile: "secret" }));
    await expect(readDispatchRuntime(file)).rejects.toThrow();
  });
});
