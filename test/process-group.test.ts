import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

import { terminateProcessGroup } from "../src/process-group.js";
import {
  processGroupHasLiveMembers,
  readProcessIdentity,
  signalProcessGroup,
} from "../src/process-identity.js";

const groups = new Set<number>();

afterEach(() => {
  for (const group of groups) signalProcessGroup(group, "SIGKILL");
  groups.clear();
});

describe("process group termination", () => {
  test("terminates and confirms a normal group is absent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("fixture did not start");
    groups.add(child.pid);
    const identity = await readProcessIdentity(child.pid);

    await terminateProcessGroup({
      identity,
      processGroupId: child.pid,
      terminationGraceMs: 100,
      killGraceMs: 100,
    });

    expect(await processGroupHasLiveMembers(child.pid)).toBe(false);
    groups.delete(child.pid);
  });

  test("escalates a TERM-resistant group", async () => {
    const child = spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: "ignore" });
    if (!child.pid) throw new Error("fixture did not start");
    groups.add(child.pid);
    const identity = await readProcessIdentity(child.pid);
    await new Promise((resolve) => setTimeout(resolve, 30));

    await terminateProcessGroup({
      identity,
      processGroupId: child.pid,
      terminationGraceMs: 30,
      killGraceMs: 100,
    });

    expect(await processGroupHasLiveMembers(child.pid)).toBe(false);
    groups.delete(child.pid);
  });

  test("refuses to signal live members when the leader identity was reused", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("fixture did not start");
    groups.add(child.pid);
    const identity = await readProcessIdentity(child.pid);

    await expect(terminateProcessGroup({
      identity: { ...identity, startIdentity: "different-process-instance" },
      processGroupId: child.pid,
      terminationGraceMs: 20,
      killGraceMs: 20,
    })).rejects.toThrow("reused leader");

    expect(await processGroupHasLiveMembers(child.pid)).toBe(true);
  });
});
