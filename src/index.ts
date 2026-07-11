export {
  agent,
  copilotCliAvailable,
  copilotSdkAvailable,
  createCopilotAgentFromClient,
  createCopilotAgentFromGenerate,
  nativeCodexAcpAvailable,
  promptCodexWithSchema,
  withAgent,
  type AgentOptions,
  type SigilAgent,
} from "./agents.js";
export {
  createContext,
  loadConfiguredContext,
  renderContextBlock,
  sigil,
  wrapAgentForContext,
  type AgentWriteOptions,
  type AgentWrites,
  type ArtifactHelpers,
  type CreateContextOptions,
  type ContextAgentFactory,
  type LoadedContext,
  type LoadedContextEntry,
  type ParallelSettledResult,
  type RichSigilAgent,
  type ShellCommand,
  type ShellResult,
  type SigilContext,
  type SkippedContextEntry,
} from "./context.js";
export {
  CONFIG_FILE,
  DEFAULT_SIGIL_CONFIG,
  loadConfig,
  resolveAgentBinding,
  resolveEvalCommand,
  type AgentBinding,
  type AgentProvider,
  type ContextEntry,
  type SigilConfig,
} from "./config.js";
export {
  BACKLOG_CONTRACT_VERSION,
  checkBacklog,
  orderItems,
  validateBacklog,
  type Backlog,
  type BacklogCheck,
  type WorkItem,
} from "./contracts/backlog.js";
export {
  CONTRACT_VERSION,
  checkTaskGraph,
  planBatches,
  validateTaskGraph,
  type FileAction,
  type Task,
  type TaskFile,
  type TaskGraph,
  type TaskGraphCheck,
  type TaskGraphCheckOptions,
} from "./contracts/task-graph.js";
export {
  dispatch,
  verifyBase,
  type DeliveryPolicy,
  type DispatchInput,
  type DispatchItemResult,
  type DispatchOptions,
  type DispatchResult,
  type FinalPullRequestResult,
  type VerifyBaseResult,
} from "./workflows/dispatch/index.js";
export {
  changedPaths,
  checkoutIntegrationBranch,
  checkoutFreshBranch,
  commitAll,
  createPr,
  gh,
  git,
  isCleanTree,
  mergePr,
  publish,
  push,
  type AttemptResult,
  type CommandResult,
  type CommitResult,
  type MergePrDeps,
  type PublishDeps,
  type PublishInput,
  type PublishResult,
} from "./git.js";
export { createArtifactRoot } from "./paths.js";
export {
  recover,
  type FailureKind,
  type RecoveryAttempt,
  type RecoveryOptions,
  type RecoveryResult,
  type WorkflowFailure,
} from "./recovery/index.js";
export { createPromptGroup, interpolate, type Prompt, type PromptGroup } from "./prompts.js";
export { type RunPersistence } from "./storage.js";
export {
  loadTypeScriptSigil,
  runTypeScriptSigil,
  SigilRunnerError,
  validateTypeScriptSigil,
  type RunSigilInput,
  type RunSigilResult,
  type TypeScriptSigil,
  type ValidateSigilResult,
} from "./sigil-runner.js";
export { breakdown, type BreakdownInput, type BreakdownResult } from "./workflows/breakdown/index.js";
export { breakdownPrompts } from "./workflows/breakdown/prompts.js";
export { softwareChange, type SoftwareChangeInput, type SoftwareChangeResult, type SoftwareChangeStage } from "./workflows/software-change/workflow.js";
export { implement, slugifyBranch, type ImplementInput, type ImplementResult } from "./workflows/software-change/implementation/index.js";
export { implementationPrompts } from "./workflows/software-change/implementation/prompts.js";
export { plan, type PlanInput, type PlanResult } from "./workflows/software-change/planning/index.js";
export { planningPrompts } from "./workflows/software-change/planning/prompts.js";
export { probePlan, type ProbeCommandResult, type ProbePlanInput, type ProbePlanResult } from "./workflows/probe/index.js";
export { refactor, type PathDiscovery, type RefactorInput, type RefactorResult } from "./workflows/refactor/index.js";
export {
  compareWithBaseline,
  establishBaseline,
  runBuildAndTest,
  verifyWithRepair,
  type Baseline,
  type VerificationResult,
} from "./verification.js";
export {
  migrate,
  MigrationBacklogSchema,
  MigrationItemSchema,
  orderMigrationItems,
  parseMigrationBacklog,
  type MigrationBacklog,
  type MigrationInput,
  type MigrationItem,
  type MigrationItemResult,
  type MigrationResult,
} from "./workflows/migrate/index.js";
export { review, ReviewFindingSchema, type ReviewFinding, type ReviewInput, type ReviewResult } from "./workflows/software-change/review/index.js";
export { reviewPrompts } from "./workflows/software-change/review/prompts.js";
export { compileYamlWorkflow } from "./yaml/compile.js";
export { parseYamlWorkflow, validateYamlWorkflow, validateYamlWorkflowFile } from "./yaml/validate.js";
export { runYamlWorkflowFile } from "./yaml/run.js";
export type {
  CompiledYamlAgentJob,
  CompiledYamlDeterministicJob,
  CompiledYamlStage,
  CompiledYamlWorkflow,
  YamlAgentRef,
  YamlAgentStep,
  YamlDeterministicStep,
  YamlEvalStep,
  YamlJob,
  YamlPromptOutput,
  YamlPromptStep,
  YamlRunResult,
  YamlRunStep,
  YamlScriptStep,
  YamlStage,
  YamlStep,
  YamlValidationResult,
  YamlWorkflow,
} from "./yaml/types.js";
