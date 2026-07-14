import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";
import ts from "typescript";

const rootRuntime = [
  "CONFIG_FILE",
  "DEFAULT_SIGIL_CONFIG",
  "EFFECTIVE_CONFIG_VERSION",
  "agent",
  "breakdown",
  "breakdownPrompts",
  "compileYamlWorkflow",
  "createContext",
  "dispatch",
  "implement",
  "implementationPrompts",
  "loadConfig",
  "loadConfiguredContext",
  "migrate",
  "parseAgentBinding",
  "plan",
  "planningPrompts",
  "probePlan",
  "projectEffectiveConfig",
  "promptTextWithSchema",
  "providerCapabilities",
  "providerTransports",
  "refactor",
  "renderContextBlock",
  "renderEffectiveConfig",
  "resolveAgentBinding",
  "resolveConfig",
  "resolveEvalCommand",
  "resolveExecutionPolicy",
  "review",
  "reviewPrompts",
  "runYamlWorkflowFile",
  "sigil",
  "softwareChange",
  "withAgent",
  "wrapAgentForContext",
].sort();

const rootDeclarations = [
  ...rootRuntime,
  "AgentBinding",
  "AgentEffort",
  "AgentOptions",
  "AgentProvider",
  "AgentWriteOptions",
  "AgentWrites",
  "ArtifactHelpers",
  "AttributedValue",
  "BreakdownInput",
  "BreakdownResult",
  "CapabilitySupport",
  "ConfigOverlay",
  "ConfigSource",
  "ContextAgentFactory",
  "ContextEntry",
  "CreateContextOptions",
  "DeliveryPolicy",
  "DispatchInput",
  "DispatchItemResult",
  "DispatchResult",
  "EffectiveCapability",
  "EffectiveConfig",
  "EffectiveConfigOptions",
  "EffectiveExecutionPolicy",
  "ExecutionPolicy",
  "ExecutionResolution",
  "FinalPullRequestResult",
  "ImplementInput",
  "ImplementResult",
  "LoadedContext",
  "LoadedContextEntry",
  "MigrationInput",
  "MigrationItemResult",
  "MigrationResult",
  "ParallelSettledResult",
  "PathDiscovery",
  "PlanInput",
  "PlanResult",
  "ProbeCommandResult",
  "ProbePlanInput",
  "ProbePlanResult",
  "ProviderCapabilities",
  "RedactedValue",
  "RefactorInput",
  "RefactorResult",
  "RequestedExecutionPolicy",
  "ResolvedConfig",
  "ReviewFinding",
  "ReviewInput",
  "ReviewResult",
  "RichSigilAgent",
  "SafeConfigLocation",
  "ShellCommand",
  "ShellResult",
  "SigilAgent",
  "SigilConfig",
  "SigilContext",
  "SkippedContextEntry",
  "SoftwareChangeInput",
  "SoftwareChangeResult",
  "SoftwareChangeStage",
].sort();

const contractsRuntime = [
  "BACKLOG_CONTRACT_VERSION",
  "CONTRACT_VERSION",
  "CommandVerificationSchema",
  "ConsumedInterfaceSchema",
  "ManualVerificationSchema",
  "ProducedInterfaceSchema",
  "TaskFileSchema",
  "TaskGraphSchema",
  "TaskInterfacesSchema",
  "TaskSchema",
  "TaskVerificationSchema",
  "YamlJobSchema",
  "YamlStageSchema",
  "YamlStepSchema",
  "YamlWorkflowSchema",
  "canonicalTaskGraph",
  "checkBacklog",
  "checkTaskGraph",
  "orderItems",
  "orderedTasks",
  "parseYamlWorkflow",
  "taskGraphDigest",
  "taskGraphJsonSchema",
  "validateBacklog",
  "validateTaskGraph",
  "validateYamlWorkflow",
].sort();

const contractsDeclarations = [
  ...contractsRuntime,
  "Backlog",
  "BacklogCheck",
  "CompiledYamlAgentJob",
  "CompiledYamlDeterministicJob",
  "CompiledYamlStage",
  "CompiledYamlWorkflow",
  "CommandVerification",
  "ConsumedInterface",
  "FileAction",
  "ManualVerification",
  "ProducedInterface",
  "Task",
  "TaskFile",
  "TaskGraph",
  "TaskGraphCheck",
  "TaskGraphCheckOptions",
  "TaskInterfaces",
  "TaskVerification",
  "WorkItem",
  "YamlAgentRef",
  "YamlAgentStep",
  "YamlDeterministicStep",
  "YamlEvalStep",
  "YamlJob",
  "YamlPromptOutput",
  "YamlPromptStep",
  "YamlRunResult",
  "YamlRunStep",
  "YamlScriptStep",
  "YamlStage",
  "YamlStep",
  "YamlValidationResult",
  "YamlWorkflow",
].sort();

let consumer: string;

function run(command: string[], cwd = process.cwd()) {
  return Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
}

function declarationExports(specifier: string): string[] {
  const file = join(consumer, `${specifier === "sigil" ? "root" : "contracts"}.ts`);
  writeFileSync(file, `export * from ${JSON.stringify(specifier)};\n`);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  });
  const source = program.getSourceFile(file)!;
  expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.messageText)).toEqual([]);
  return program.getTypeChecker().getExportsOfModule(program.getTypeChecker().getSymbolAtLocation(source)!)
    .map((symbol) => symbol.name)
    .sort();
}

beforeAll(() => {
  const built = run(["bun", "run", "build"]);
  expect(built.exitCode, built.stderr.toString()).toBe(0);
  consumer = mkdtempSync("/tmp/sigil-public-exports-");
  const temporary = join(consumer, "tmp");
  mkdirSync(temporary);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const installed = Bun.spawnSync({
    cmd: ["bun", "add", join(process.cwd(), "dist", "package"), "--offline"],
    cwd: consumer,
    env: { ...process.env, TMPDIR: temporary },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(installed.exitCode, installed.stderr.toString()).toBe(0);
}, 30_000);

describe("public package exports", () => {
  test("runtime and declaration symbols match reviewed allowlists", async () => {
    const imported = run([
      "node",
      "--input-type=module",
      "-e",
      'const root = await import("sigil"); const contracts = await import("sigil/contracts"); console.log(JSON.stringify({ root: Object.keys(root).sort(), contracts: Object.keys(contracts).sort() }))',
    ], consumer);
    expect(imported.exitCode, imported.stderr.toString()).toBe(0);
    const runtime = JSON.parse(imported.stdout.toString());

    expect(runtime.root).toEqual(rootRuntime);
    expect(runtime.contracts).toEqual(contractsRuntime);
    expect(declarationExports("sigil")).toEqual(rootDeclarations);
    expect(declarationExports("sigil/contracts")).toEqual(contractsDeclarations);
  });

  test("package resolution exposes only reviewed entrypoints", () => {
    for (const specifier of ["sigil/src/index.js", "sigil/git", "sigil/yaml/run"]) {
      const result = run(["node", "--input-type=module", "-e", `import(${JSON.stringify(specifier)})`], consumer);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    }
    const server = run(["node", "--input-type=module", "-e", 'import("sigil/server")'], consumer);
    expect(server.exitCode, server.stderr.toString()).toBe(0);
  });
});
