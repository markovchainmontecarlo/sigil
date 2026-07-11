import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

function run(cmd: string[]) {
  return Bun.spawnSync({ cmd, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

describe("distribution scripts", () => {
  test("pack.sh and install.sh are bash syntax-valid", () => {
    expect(run(["bash", "-n", "scripts/pack.sh"]).exitCode).toBe(0);
    expect(run(["bash", "-n", "scripts/install.sh"]).exitCode).toBe(0);
    expect(run(["bash", "-n", "scripts/distribution-smoke.sh"]).exitCode).toBe(0);
  });

  test("pack.sh uses bun pm pack with the dist destination", () => {
    const script = readFileSync("scripts/pack.sh", "utf8");

    expect(script).toContain("bun pm pack --destination dist/");
  });

  test("install.sh verifies checksums, installs production deps, writes launcher, and stays keyless", () => {
    const script = readFileSync("scripts/install.sh", "utf8");

    expect(script).toContain("shasum -a 256");
    expect(script).toContain("bun install --production --frozen-lockfile");
    expect(script).toContain("gh release download");
    expect(script).toContain("SIGIL_RELEASE_TARBALL");
    expect(script).toContain("RELEASE_ASSET_GLOB");
    expect(script).toContain(".claude/skills");
    expect(script).toContain(".codex/skills");
    expect(script).toContain("ln -s");
    expect(script).toContain('for skill_path in "$SKILL_DIR"/*');
    expect(script).toContain("$BIN_DIR/sigil");
    expect(script).toContain(".local/bin");
    expect(script).not.toContain("ANTHROPIC_API_KEY");
    expect(script).not.toContain("OPENAI_API_KEY");
  });

  test("pack.sh injects the lockfile and writes the checksum file", () => {
    const script = readFileSync("scripts/pack.sh", "utf8");

    expect(script).toContain("cp bun.lock");
    expect(script).toContain('tee "$tarball.sha256"');
  });

  test("distribution-smoke.sh exercises both fresh install and update", () => {
    const script = readFileSync("scripts/distribution-smoke.sh", "utf8");

    expect(script).toContain("=== fresh install ===");
    expect(script).toContain("=== update install ===");
    expect(script).toContain("SIGIL_RELEASE_TARBALL");
    expect(script).toContain("stale-skill");
    expect(script).toContain(".claude/skills/sigil");
    expect(script).toContain(".claude/skills/sigil-authoring");
    expect(script).toContain(".codex/skills/sigil");
    expect(script).toContain(".codex/skills/sigil-authoring");
    expect(script).toContain(".local/share/man/man1/sigil.1");
    expect(script).toContain("readlink");
    expect(script).toContain("distribution smoke passed");
    expect(script).not.toContain("durable-context");
  });

  test("generate-man.ts renders the checked-in man page from command help", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-man-"));
    const outFile = join(dir, "sigil.1");
    const result = run(["bun", "scripts/generate-man.ts", outFile]);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe(readFileSync("man/sigil.1", "utf8"));
  });
});
