import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { discoverRunDirectories } from "../src/dashboard/discovery.js";

describe("dashboard run discovery", () => {
  test("discovers supported layouts without treating nested artifacts as runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-discovery-"));
    const detached = join(root, "detached");
    const dispatch = join(root, "workspace", ".sigil", "runs", "delivery");
    const nested = join(dispatch, "artifacts", "dispatch", "item");
    mkdirSync(detached, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(detached, "manifest.json"), "{}");
    writeFileSync(join(detached, "status.json"), "{}");
    writeFileSync(join(dispatch, "artifacts", "status.json"), "{}");
    writeFileSync(join(nested, "status.json"), "{}");
    writeFileSync(join(nested, "events.jsonl"), "");

    const runs = await discoverRunDirectories([root]);

    expect(runs).toEqual([detached, dispatch].sort());
  });

  test("does not follow symlinked directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-dashboard-links-"));
    const outside = mkdtempSync(join(tmpdir(), "sigil-dashboard-outside-"));
    mkdirSync(join(outside, "run"));
    writeFileSync(join(outside, "run", "status.json"), "{}");
    writeFileSync(join(outside, "run", "events.jsonl"), "");
    symlinkSync(outside, join(root, "linked"));

    expect(await discoverRunDirectories([root])).toEqual([]);
  });
});
