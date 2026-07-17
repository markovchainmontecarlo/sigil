import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

function run(cmd: string[]) {
  return Bun.spawnSync({ cmd, cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
}

describe("distribution scripts", () => {
  test("release validation is repository-owned and test files run in isolated processes", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const suite = readFileSync("scripts/test-suite.ts", "utf8");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(manifest.scripts["test:fast"]).toBe("bun scripts/test-suite.ts fast");
    expect(manifest.scripts["test:integration"]).toBe("bun scripts/test-suite.ts integration");
    expect(manifest.scripts["verify:package"]).toBe(
      "node --experimental-strip-types scripts/verify-package.ts",
    );
    expect(manifest.scripts["validate:release"]).toBe(
      "bun run typecheck && bun run test:all && bun run verify:package",
    );
    expect(suite).toContain("for (const file of files) runTests([file], suiteBudgets[suite.name]);");
    expect(suite).not.toContain("runTests(grouped");
    expect(ci).toContain("- run: bun run validate:release");
    expect(ci).not.toContain("- run: bun run typecheck");
    expect(ci).not.toContain("- run: bun run test:all");
    expect(ci).not.toContain("- run: bun run verify:package");
  });

  test("pack.sh and install.sh are bash syntax-valid", () => {
    expect(run(["bash", "-n", "scripts/pack.sh"]).exitCode).toBe(0);
    expect(run(["bash", "-n", "scripts/install.sh"]).exitCode).toBe(0);
    expect(run(["bash", "-n", "scripts/distribution-smoke.sh"]).exitCode).toBe(0);
  });

  test("pack.sh delegates to authoritative package verification", () => {
    const script = readFileSync("scripts/pack.sh", "utf8");

    expect(script).toContain("exec bun run verify:package");
  });

  test("install.sh verifies checksums, installs production deps, writes launcher, and stays keyless", () => {
    const script = readFileSync("scripts/install.sh", "utf8");

    expect(script).toContain("shasum -a 256");
    expect(script).toContain("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
    expect(script).toContain("gh release download");
    expect(script).toContain("SIGIL_RELEASE_TARBALL");
    expect(script).toContain("RELEASE_ASSET_GLOB");
    expect(script).toContain(".claude/skills");
    expect(script).toContain(".codex/skills");
    expect(script).toContain("ln -s");
    expect(script).toContain('for skill_path in "$SKILL_DIR"/*');
    expect(script).toContain("$BIN_DIR/sigil");
    expect(script).toContain(".local/bin");
    expect(script).toContain("lib/src/cli.js");
    expect(script).not.toContain("lib/src/cli.ts");
    expect(script).not.toContain("ANTHROPIC_API_KEY");
    expect(script).not.toContain("OPENAI_API_KEY");
  });

  test("package verification owns two artifacts, parity, and explicit checks", () => {
    const script = readFileSync("scripts/verify-package.ts", "utf8");

    expect(script).toContain("-registry.tgz");
    expect(script).toContain("-installer.tgz");
    expect(script).toContain('"npm", "install", "--package-lock-only"');
    expect(script).toContain("assertSharedBytes");
    expect(script).toContain("assertInventory");
    expect(script).toContain("test-package-consumers.ts");
    expect(script).toContain("distribution-smoke.sh");
    expect(script).toContain('["skills", "docs", "man"]');
    expect(script).toContain('["ARCHITECTURE.md", "SIGIL_USAGE.md"]');
  });

  test("distribution-smoke.sh exercises both fresh install and update", () => {
    const script = readFileSync("scripts/distribution-smoke.sh", "utf8");

    expect(script).toContain("=== fresh install ===");
    expect(script).toContain("=== update install ===");
    expect(script).toContain('NPM_CONFIG_CACHE="$npm_cache"');
    expect(script).toContain("SIGIL_RELEASE_TARBALL");
    expect(script).toContain("installer archive path required");
    expect(script).toContain("stale-skill");
    expect(script).toContain("sigil-plan");
    expect(script).toContain("sigil-task-graph");
    expect(script).toContain("user-skill");
    expect(script).toContain(".claude/skills/sigil");
    expect(script).toContain(".claude/skills/sigil-authoring");
    expect(script).toContain(".codex/skills/sigil");
    expect(script).toContain(".codex/skills/sigil-authoring");
    expect(script).toContain(".local/share/man/man1/sigil.1");
    expect(script).toContain("readlink");
    expect(script).toContain("run-sigil");
    expect(script).toContain("distribution smoke passed");
    expect(script).not.toContain("durable-context");
  });

  test("the packaged skill set and its authoritative documents agree", () => {
    const skills = readdirSync("skills", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual([
      "sigil",
      "sigil-authoring",
      "sigil-brief",
      "sigil-dispatch",
      "sigil-migration",
      "sigil-refactor",
      "sigil-task-graph",
    ]);
    expect(existsSync("docs/explanation/workflow-patterns.md")).toBe(true);
    expect(existsSync("docs/explanation/ephemeral-sigil-patterns.md")).toBe(false);
    expect(existsSync("docs/how-to/temporary-typescript-sigil.md")).toBe(true);
    expect(existsSync("docs/how-to/ephemeral-sigils.md")).toBe(false);

    for (const skill of skills) {
      const skillFile = `skills/${skill}/SKILL.md`;
      const contents = readFileSync(skillFile, "utf8");
      const metadata = readFileSync(`skills/${skill}/agents/openai.yaml`, "utf8");

      expect(contents).not.toContain("ephemeral-sigil-patterns.md");
      expect(metadata).toContain(`$${skill}`);

      const links = [...contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
      for (const link of links) {
        if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("#")) continue;
        expect(existsSync(resolve(dirname(skillFile), link.split("#", 1)[0]))).toBe(true);
      }
    }
  });

  test("generate-man.ts renders the checked-in man page from command help", () => {
    const dir = mkdtempSync(join(tmpdir(), "sigil-man-"));
    const outFile = join(dir, "sigil.1");
    const result = run(["bun", "scripts/generate-man.ts", outFile]);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe(readFileSync("man/sigil.1", "utf8"));
  });
  test("Claude subscription smoke is optional, transport-neutral, and credential-safe", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const script = readFileSync("scripts/smoke-claude-subscription.mjs", "utf8");

    expect(manifest.scripts["smoke:claude-subscription"]).toBe("bun scripts/smoke-claude-subscription.mjs");
    expect(manifest.scripts["smoke:claude-pty"]).toBeUndefined();
    expect(existsSync("scripts/smoke-claude-pty.mjs")).toBe(false);
    expect(script).not.toContain("ANTHROPIC_API_KEY");
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
  });

});
