import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

type SourceFile = { path: string; text: string };
type Rule = { name: string; pattern: RegExp; allowed?: Set<string> };
type DiagramExpectation = { workflow: string; labels: string[] };

const sourceRoot = join(process.cwd(), "src");
const complexWorkflowDiagrams: DiagramExpectation[] = [
  {
    workflow: "software-change",
    labels: [
      "configured planner roles run in parallel",
      "configured synthesizer role",
      "build typed task graph artifact",
      "implementation-owned review stage",
      "no publish, push, pull request, or merge",
    ],
  },
  {
    workflow: "breakdown",
    labels: [
      "Run configured planners in parallel",
      "configured synthesizer role",
      "Enrich backlog item briefs",
      "Repair backlog JSON with breakdown prompt",
      "Order backlog items by dependencies",
    ],
  },
  {
    workflow: "dispatch",
    labels: [
      "read and validate backlog",
      "serial dependency-ordered item loop",
      "fork dispatch item artifact context",
      "call softwareChange in item context",
      "publish one final integration PR to main",
      "run build and test on updated delivery base",
    ],
  },
  {
    workflow: "probe",
    labels: [
      "configured planner roles run in parallel",
      "sandbox command loop",
      "configured synthesizer role writes findings",
      "repair task graph JSON",
      "target changed paths unchanged",
    ],
  },
  {
    workflow: "refactor",
    labels: [
      "configured planner role analyzes structure",
      "configured synthesizer role creates slice plan",
      "protected paths unchanged",
      "configured reviewer role runs structure and behavior reviews in parallel",
      "per-finding repair attempts remain",
    ],
  },
  {
    workflow: "migrate",
    labels: [
      "load or create migration state",
      "clean tree at checkpoint head",
      "dependency-ordered item loop",
      "run self-healing refactor workflow",
      "write state checkpoint atomically",
      "configured reviewer role runs architecture and behavior reviews in parallel",
    ],
  },
];

const rules: Rule[] = [
  { name: "do not clobber artifacts with agent turn text", pattern: /\bwriteFileSync\s*\([^,\n]+,\s*[^)\n]*\.text\b/ },
  { name: "provider literals are only allowed in provider-owned modules", pattern: /["'](?:claude|codex|copilot)["']/, allowed: new Set(["src/agent-binding.ts", "src/claude-pty.ts", "src/claude-profiles.ts", "src/claude-router.ts", "src/codex-router.ts", "src/config.ts", "src/provider-capabilities.ts", "src/provider-profiles.ts", "src/provider-profile-service.ts", "src/providers/index.ts", "src/providers/codex.ts", "src/providers/claude.ts", "src/providers/copilot.ts"]) },
  { name: "z.any is forbidden", pattern: /\bz\.any\s*\(/ },
  { name: "old orchestration identifiers are forbidden", pattern: /\b(?:setState|residual|fanout|spine|lane|slot)\b/ },
  { name: "Mastra imports are only allowed at integration seams", pattern: /^\s*import\b.*["']@mastra\//, allowed: new Set(["src/agents.ts", "src/claude-sdk.ts", "src/mastra.ts"]) },
  { name: "process.chdir is forbidden", pattern: /\bprocess\.chdir\s*\(/ },
];

const seededViolations: Array<[string, SourceFile]> = [
  ["do not clobber artifacts with agent turn text", { path: "src/workflows/old.ts", text: "writeFileSync(file, turn.text);" }],
  ["provider literals are only allowed in provider-owned modules", { path: "src/workflows/software-change/planning/index.ts", text: "const provider = 'claude';" }],
  ["z.any is forbidden", { path: "src/contracts/example.ts", text: "const schema = z.any();" }],
  ["old orchestration identifiers are forbidden", { path: "src/workflows/software-change/implementation/index.ts", text: "const residual = [];" }],
  ["Mastra imports are only allowed at integration seams", { path: "src/gate.ts", text: "import { createStep } from '@mastra/core/workflows';" }],
  ["process.chdir is forbidden", { path: "src/workflows/example.ts", text: "process.chdir(repo);" }],
];

function normalizePath(path: string): string {
  return path.split(/[\\/]+/).join("/");
}

function walk(dir: string): SourceFile[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) return entry === "node_modules" ? [] : walk(absolutePath);
    if (!/\.[cm]?[jt]sx?$/.test(entry)) return [];
    return [{ path: normalizePath(join("src", relative(sourceRoot, absolutePath))), text: readFileSync(absolutePath, "utf8") }];
  });
}

function walkRepositoryFiles(dir: string, base = process.cwd()): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === ".git" || entry === "node_modules") return [];

    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) return walkRepositoryFiles(absolutePath, base);

    return [normalizePath(relative(base, absolutePath))];
  });
}

function workflowDiagram(workflow: string): string {
  return readFileSync(join(sourceRoot, "workflows", workflow, "workflow.mermaid"), "utf8");
}

function findViolations(files: SourceFile[], selectedRules = rules): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of selectedRules) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line) && !rule.allowed?.has(file.path)) {
          violations.push(`${file.path}:${index + 1}: ${rule.name}: ${line.trim()}`);
        }
      }
    });
  }
  return violations;
}

describe("src structural invariants", () => {
  test("real tree satisfies grep-detectable invariants", () => {
    expect(findViolations(walk(sourceRoot))).toEqual([]);
  });

  for (const [ruleName, file] of seededViolations) {
    test(`${ruleName} reports file and line`, () => {
      const rule = rules.find((candidate) => candidate.name === ruleName);
      expect(rule).toBeDefined();
      const violations = findViolations([file], [rule!]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toStartWith(`${file.path}:1:`);
    });
  }


  test("task graph prompts are owned by software-change planning", () => {
    expect(() => statSync(join(sourceRoot, "workflows/task-graph/prompts.ts"))).toThrow();
    expect(() => statSync(join(sourceRoot, "workflows/task-graph/prompts/enrichTaskGraph.md"))).toThrow();
    expect(statSync(join(sourceRoot, "workflows/software-change/planning/prompts/enrichTaskGraph.md")).isFile()).toBe(true);
    expect(statSync(join(sourceRoot, "workflows/software-change/planning/prompts/fixJson.md")).isFile()).toBe(true);
  });

  test("workflow prompt templates live with owning feature modules", () => {
    expect(existsSync(join(process.cwd(), "prompts"))).toBe(false);
    expect(() => statSync(join(sourceRoot, "sigils"))).toThrow();
  });

  test("software-change workflow keeps delivery outside the library workflow", () => {
    const workflow = readFileSync(join(sourceRoot, "workflows/software-change/workflow.ts"), "utf8");

    expect(workflow).not.toMatch(/\b(?:publish|push|pullRequest|merge)\b/);
    expect(workflow).not.toContain("../../git.js");
  });

  test("assistant routing does not turn an active Markdown plan into implicit agentic planning", () => {
    const router = readFileSync(join(process.cwd(), "skills/sigil/SKILL.md"), "utf8");
    const usage = readFileSync(join(process.cwd(), "SIGIL_USAGE.md"), "utf8");

    for (const guidance of [router, usage]) {
      expect(guidance).toContain("active Markdown plan");
      expect(guidance).toContain("task graph");
      expect(guidance).toContain("explicitly");
    }
    expect(router).toContain("Do not infer this choice.");
    expect(usage).toContain("Its presence does not select `software-change --brief`.");
  });

  test("explicit Sigil routing establishes a confirmed handoff without self-reference", () => {
    const router = readFileSync(join(process.cwd(), "skills/sigil/SKILL.md"), "utf8");

    expect(router).toContain("Treat “use Sigil” or “use the Sigil skill” as a request to establish the brief and route the unfinished transition");
    expect(router).toContain("show its complete contents");
    expect(router).toContain("wait for confirmation or correction");
    expect(router).toContain("## Detailed guidance");
    expect(router).not.toContain("Use this skill");
    expect(router).not.toContain("invoking this skill");
  });

  test("complex workflows own checked-in stage diagrams with stable structural labels", () => {
    for (const expected of complexWorkflowDiagrams) {
      const diagram = workflowDiagram(expected.workflow);

      expect(diagram).toStartWith("flowchart TD");
      for (const label of expected.labels) expect(diagram).toContain(label);
      expect(diagram).not.toMatch(/\b(?:codex|claude|copilot|gpt-[\w.-]+)\b/i);
    }
  });

  test("diagram coverage does not introduce rendering dependencies, generated images, or build steps", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const packageText = JSON.stringify({
      dependencies: packageJson.dependencies ?? {},
      devDependencies: packageJson.devDependencies ?? {},
      scripts: packageJson.scripts ?? {},
    });
    const lockText = readFileSync(join(process.cwd(), "bun.lock"), "utf8");
    const generatedDiagramImages = walkRepositoryFiles(process.cwd())
      .filter((path) => /(?:^|\/)workflow\.(?:svg|png|jpg|jpeg|webp)$/i.test(path));

    expect(packageText).not.toMatch(/\b(?:mermaid|puppeteer|playwright|sharp|canvas)\b/i);
    expect(lockText).not.toMatch(/\b(?:mermaid|puppeteer|playwright|sharp|canvas)\b/i);
    expect(generatedDiagramImages).toEqual([]);
  });

  test("dispatch owns delivery policy and calls software-change as a library workflow", () => {
    const dispatch = readFileSync(join(sourceRoot, "workflows/dispatch/index.ts"), "utf8");
    const softwareChange = readFileSync(join(sourceRoot, "workflows/software-change/workflow.ts"), "utf8");

    expect(dispatch).toContain("../software-change/workflow.js");
    expect(dispatch).toContain("../../git.js");
    expect(softwareChange).not.toContain("../dispatch/");
    expect(softwareChange).not.toContain("../../git.js");
  });

  test("provider literal in a workflow reports the offending file and line", () => {
    const violations = findViolations([{ path: "src/workflows/example.ts", text: "ok();\nconst provider = \"claude\";" }]);
    expect(violations).toContain('src/workflows/example.ts:2: provider literals are only allowed in provider-owned modules: const provider = "claude";');
  });
});
