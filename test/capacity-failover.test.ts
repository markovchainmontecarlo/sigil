import { describe, expect, test } from "bun:test";

import { runFreshAgentOperation } from "../src/agent-operation.js";
import { ProviderError } from "../src/provider-failure.js";
import type { RichSigilAgent, SigilContext } from "../src/context.js";

describe("capacity failover", () => {
  test("provider capacity failures remain operation-local", async () => {
    const events: string[] = [];
    const profiles = ["a", "b"];
    const ctx = {
      repo: process.cwd(),
      async withAgent(_binding: unknown, fn: (agent: RichSigilAgent) => Promise<unknown>) {
        const selected = profiles.shift()!;
        events.push(`start:${selected}`);
        const agent = {
          runtime: { profile: selected },
          close: async () => {},
          prompt: async () => "",
        } as unknown as RichSigilAgent;

        try {
          return await fn(agent);
        } finally {
          events.push(`close:${selected}`);
        }
      },
      observe: async () => {},
    } as unknown as SigilContext;

    const result = await runFreshAgentOperation(
      ctx,
      { provider: "codex", model: "test" },
      { stage: "scripted", limit: 0, timeoutMs: 1_000 },
      async (agent) => {
        if (agent.runtime?.profile === "a") {
          throw new ProviderError("provider capacity exhausted", {
            code: "capacity_exhausted",
            account: "a",
          });
        }
        return agent.runtime?.profile;
      },
    );

    expect(result).toMatchObject({ ok: true, value: "b", attempts: 1 });
    expect(events).toEqual(["start:a", "close:a", "start:b", "close:b"]);
  });
});
