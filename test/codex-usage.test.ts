import { describe, expect, test } from "bun:test";

import { addCodexUsage, usageFromEvent } from "../src/providers/codex.js";

describe("Codex ACP usage accounting", () => {
  test("parses the installed ACP usage_update schema", () => {
    const usage = usageFromEvent({
      type: "session-update",
      update: { sessionUpdate: "usage_update", used: 321, size: 200_000 },
    });

    expect(usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 321,
    });
  });

  test("keeps the latest cumulative update within a turn and adds completed turns once", () => {
    const firstPartial = usageFromEvent({
      type: "session-update",
      update: { sessionUpdate: "usage_update", used: 40, size: 200_000 },
    });
    const firstComplete = usageFromEvent({
      type: "session-update",
      update: { sessionUpdate: "usage_update", used: 75, size: 200_000 },
    }, firstPartial);
    const secondComplete = usageFromEvent({
      type: "session-update",
      update: { sessionUpdate: "usage_update", used: 25, size: 200_000 },
    });

    expect(firstComplete?.totalTokens).toBe(75);
    expect(addCodexUsage(firstComplete, secondComplete)?.totalTokens).toBe(100);
  });
});
