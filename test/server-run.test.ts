import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runWorkflow } from "../src/server-entry.js";
import { ProviderError } from "../src/provider-failure.js";
import type { ServerEvent } from "../src/server/types.js";

function externalRoot(): string {
  return mkdtempSync("/tmp/sigil-server-run-");
}

function options(root: string, events: ServerEvent[] = []) {
  return {
    runId: "opaque/run:id",
    workflowId: "deterministic-test",
    artifactRoot: root,
    onEvent: async (event: ServerEvent) => {
      events.push(event);
    },
  };
}

describe("server run API", () => {
  test("preserves typed results and delivers ordered events before returning", async () => {
    const events: ServerEvent[] = [];
    const root = externalRoot();
    const ignoreBefore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    const result = await runWorkflow(
      async (input: { repo: string; value: number }, context) => {
        await context!.observe("calculated", { value: input.value });
        await context!.artifacts.write("result.txt", String(input.value * 2));
        return { doubled: input.value * 2 };
      },
      { repo: process.cwd(), value: 4 },
      options(root, events),
    );

    expect(result).toEqual({
      version: 1,
      status: "succeeded",
      runId: "opaque/run:id",
      result: { doubled: 8 },
    });
    expect(events.map((event) => [event.kind, event.stage, event.sequence])).toEqual([
      ["lifecycle", "started", 0],
      ["diagnostic", "calculated", 1],
      ["lifecycle", "succeeded", 2],
    ]);
    expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("8");
    expect(existsSync(join(root, "events.jsonl"))).toBe(false);
    expect(existsSync(join(root, "status.json"))).toBe(false);
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8")).toBe(ignoreBefore);
  });

  test("rejects relative and repository-contained artifact roots", async () => {
    const workflow = async (_input: { repo: string }) => "not called";
    const relative = await runWorkflow(workflow, { repo: process.cwd() }, options("relative"));
    const contained = await runWorkflow(
      workflow,
      { repo: process.cwd() },
      options(join(process.cwd(), ".sigil", "external")),
    );

    expect(relative.status).toBe("failed");
    expect(relative.status === "failed" && relative.error.code).toBe("validation_failed");
    expect(contained.status === "failed" && contained.error.code).toBe("validation_failed");
  });

  test("rejects an external artifact-root symlink targeting the repository", async () => {
    const external = externalRoot();
    const artifactRoot = join(external, "repository-link");
    symlinkSync(process.cwd(), artifactRoot, "dir");

    const result = await runWorkflow(
      async (_input: { repo: string }) => "not called",
      { repo: process.cwd() },
      options(artifactRoot),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error.code).toBe("validation_failed");
  });

  test("contains nested context artifacts beneath the external root", async () => {
    const root = externalRoot();
    const result = await runWorkflow(
      async (input: { repo: string }, context) => {
        const nested = context!.fork({
          artifactRoot: join(root, "child"),
          operationPath: "child",
        });
        await nested.artifacts.write("nested.txt", "safe");
        expect(() => context!.fork({ artifactRoot: "/tmp", operationPath: "escape" })).toThrow();
        return input.repo;
      },
      { repo: process.cwd() },
      options(root),
    );

    expect(result.status).toBe("succeeded");
    expect(readFileSync(join(root, "child", "nested.txt"), "utf8")).toBe("safe");
  });

  test("returns a sanitized event sink failure", async () => {
    const result = await runWorkflow(
      async (_input: { repo: string }) => "not called",
      { repo: process.cwd() },
      { ...options(externalRoot()), onEvent: async () => { throw new Error("secret token"); } },
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toEqual({
      code: "event_sink_failed",
      message: "event delivery failed",
      retry: "retry",
    });
  });

  test("does not invoke a pre-aborted workflow and reports settled cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const result = await runWorkflow(
      async (_input: { repo: string }) => {
        called = true;
      },
      { repo: process.cwd() },
      { ...options(externalRoot()), signal: controller.signal },
    );

    expect(called).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" && result.error.code).toBe("cancelled");
  });

  test("reports unsettled cancellation cleanup as unsafe to retry", async () => {
    const controller = new AbortController();
    const result = await runWorkflow(
      async (_input: { repo: string }, context) => {
        await context!.processLifecycle!.started?.({
          identity: { pid: 123, startIdentity: "fake" },
          ownerIdentity: { pid: 1, startIdentity: "owner" },
          kind: "shell",
          processGroupId: 123,
        });
        controller.abort();
        throw new Error("cancelled");
      },
      { repo: process.cwd() },
      { ...options(externalRoot()), signal: controller.signal, cleanupTimeoutMs: 0 },
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toEqual({
      code: "cleanup_failed",
      message: "cleanup did not settle",
      retry: "unsafe_to_retry",
    });
  });

  test("maps stable public failure categories without exposing messages", async () => {
    const categories = [
      ["ConfigurationError", "configuration_failed"],
      ["WorkspaceError", "workspace_failed"],
      ["AuthorityError", "authority_failed"],
      ["WorkflowError", "workflow_failed"],
    ] as const;

    for (const [name, code] of categories) {
      const result = await runWorkflow(
        async (_input: { repo: string }) => {
          const error = new Error("credential=secret-value");
          error.name = name;
          throw error;
        },
        { repo: process.cwd() },
        options(externalRoot()),
      );
      expect(result.status === "failed" && result.error.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain("secret-value");
    }

    const provider = await runWorkflow(
      async (_input: { repo: string }) => {
        throw new ProviderError("secret provider response", { code: "authentication_failed" });
      },
      { repo: process.cwd() },
      options(externalRoot()),
    );
    expect(provider.status === "failed" && provider.error.code).toBe("provider_failed");
    expect(JSON.stringify(provider)).not.toContain("secret provider response");
  });

  test("redacts unexpected workflow errors", async () => {
    const result = await runWorkflow(
      async (_input: { repo: string }) => {
        throw { credential: "secret-value" };
      },
      { repo: process.cwd() },
      options(externalRoot()),
    );

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error).toEqual({
      code: "unexpected_failure",
      message: "workflow execution failed unexpectedly",
      retry: "retry",
    });
  });

  test("built server entry imports in Node without Bun globals", () => {
    const build = Bun.spawnSync({ cmd: ["bun", "run", "build"], stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const script = [
      'import { runWorkflow } from "./dist/package/src/server-entry.js";',
      'if (typeof runWorkflow !== "function") process.exit(1);',
    ].join("\n");
    const imported = Bun.spawnSync({
      cmd: ["node", "--input-type=module", "-e", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
  }, 15_000);
});
