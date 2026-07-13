import { describe, expect, test } from "bun:test";

import {
  OwnedPtyProcess,
  type OwnedPtyProcessDependencies,
  type PtySubprocess,
  type PtyTerminal,
  type SpawnPtyOptions,
} from "../src/owned-pty-process.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeProcess(processGroupId = 41) {
  const exited = deferred<number>();
  const writes: unknown[] = [];
  const signals: unknown[] = [];
  const events: string[] = [];
  let spawnOptions: SpawnPtyOptions | undefined;
  const terminal: PtyTerminal = {
    write(data) {
      writes.push(data);
      return String(data).length;
    },
    close() { events.push("terminal-closed"); },
  };
  const proc: PtySubprocess = {
    pid: 41,
    exited: exited.promise,
    terminal,
    kill(signal) {
      signals.push(signal);
      exited.resolve(137);
    },
  };
  const dependencies: OwnedPtyProcessDependencies = {
    spawn(options) {
      spawnOptions = options;
      return proc;
    },
    async readIdentity(pid = 7) {
      return { pid, startIdentity: `identity-${pid}` };
    },
    async readGroupId() { return processGroupId; },
    async terminateGroup() { events.push("group-gone"); },
  };
  return {
    dependencies,
    events,
    exited,
    signals,
    writes,
    data(value: string) {
      spawnOptions?.terminal.data(terminal, new TextEncoder().encode(value));
    },
  };
}

describe("owned PTY process", () => {
  test("exposes terminal input and output and publishes matching lifecycle records", async () => {
    const fake = fakeProcess();
    const output: string[] = [];
    const records: string[] = [];
    const owned = await OwnedPtyProcess.spawn({
      command: "shell",
      onData: (data) => output.push(new TextDecoder().decode(data)),
      lifecycle: {
        started(info) { records.push(`started:${info.kind}:${info.processGroupId}`); },
        stopped(info) {
          records.push(`stopped:${info.kind}:${info.processGroupId}`);
          fake.events.push("stopped");
        },
      },
    }, fake.dependencies);

    fake.data("ready");
    expect(owned.write("input")).toBe(5);
    expect(output).toEqual(["ready"]);
    expect(fake.writes).toEqual(["input"]);
    expect(owned.info).toEqual({
      identity: { pid: 41, startIdentity: "identity-41" },
      ownerIdentity: { pid: 7, startIdentity: "identity-7" },
      processGroupId: 41,
      kind: "pty",
    });

    await owned.close();
    expect(records).toEqual(["started:pty:41", "stopped:pty:41"]);
    expect(fake.events).toEqual(["group-gone", "terminal-closed", "stopped"]);
  });

  test("rejects a non-isolated group before started or terminal use", async () => {
    const fake = fakeProcess(40);
    let started = false;

    await expect(OwnedPtyProcess.spawn({
      command: "shell",
      lifecycle: { started() { started = true; } },
    }, fake.dependencies)).rejects.toThrow("does not own process group");

    expect(started).toBe(false);
    expect(fake.writes).toEqual([]);
    expect(fake.signals).toEqual(["SIGKILL"]);
  });

  test("abort, exit, close, wait, and disposal share one cleanup", async () => {
    const fake = fakeProcess();
    const abort = new AbortController();
    let stopped = 0;
    const owned = await OwnedPtyProcess.spawn({
      command: "shell",
      signal: abort.signal,
      lifecycle: { stopped() { stopped++; } },
    }, fake.dependencies);

    abort.abort();
    fake.exited.resolve(0);
    await Promise.all([
      owned.close(),
      owned.wait(),
      owned[Symbol.asyncDispose](),
      owned[Symbol.asyncDispose](),
    ]);

    expect(stopped).toBe(1);
    expect(fake.events.filter((event) => event === "group-gone")).toHaveLength(1);
    expect(fake.events.filter((event) => event === "terminal-closed")).toHaveLength(1);
  });

  test("terminal EOF does not stand in for subprocess exit", async () => {
    const fake = fakeProcess();
    const owned = await OwnedPtyProcess.spawn({ command: "shell" }, fake.dependencies);
    let settled = false;
    void owned.wait().then(() => { settled = true; });

    fake.data("");
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.exited.resolve(0);
    await owned.wait();
    expect(settled).toBe(true);
  });
});
