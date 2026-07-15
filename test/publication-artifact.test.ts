import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

function run(command: string[]) {
  return Bun.spawnSync({ cmd: command, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

describe("publication artifacts", () => {
  test("keeps the checkout private and emits a public staged manifest", () => {
    const built = run(["bun", "run", "build"]);
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    const root = JSON.parse(readFileSync("package.json", "utf8"));
    const staged = JSON.parse(readFileSync("dist/package/package.json", "utf8"));
    const evidence = JSON.parse(readFileSync("dist/package/build-metadata.json", "utf8"));

    expect(root.private).toBe(true);
    expect(staged.private).toBeUndefined();
    expect(staged.publishConfig).toEqual({ access: "public", provenance: true });
    expect(staged.repository.url).toContain("github.com/markovchainmontecarlo/sigil");
    expect(staged.engines).toEqual({ node: "*", bun: "*" });
    expect(staged.exports).toEqual({
      ".": { types: "./src/index.d.ts", import: "./src/index.js" },
      "./contracts": { types: "./src/contracts-entry.d.ts", import: "./src/contracts-entry.js" },
      "./server": { types: "./src/server-entry.d.ts", import: "./src/server-entry.js" },
    });
    expect(evidence.manifestIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.exportsIdentity).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);

  test("rejects absent publication evidence and leaves publication to the verified local process", () => {
    const checked = run(["bun", "scripts/verify-package.ts", "--check-record", "/tmp/missing-sigil-verification.json"]);
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const continuousIntegration = readFileSync(".github/workflows/ci.yml", "utf8");
    const scripts = Object.values(manifest.scripts).join("\n");

    expect(checked.exitCode).not.toBe(0);
    expect(checked.stderr.toString()).toContain("verification record is missing");
    expect(scripts).not.toContain("npm publish");
    expect(continuousIntegration).not.toContain("npm publish");
    expect(continuousIntegration).not.toContain("id-token: write");
    expect(continuousIntegration).not.toContain("pull_request:");
    expect(continuousIntegration).toContain("branches: [main]");
  });
});
