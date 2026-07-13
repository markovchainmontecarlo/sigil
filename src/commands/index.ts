import type { CommandName } from "../help.js";
import { discoverEnvCommand } from "./environment.js";
import { breakdownCommand, dispatchCommand, migrateCommand, probeCommand, refactorCommand } from "./repository-programs.js";
import { runSigilCommand, runWorkflowCommand } from "./run.js";
import { setupCommand } from "./setup.js";
import { taskGraphCommand } from "./task-graph.js";
import { implementCommand, planCommand, reviewCommand, softwareChangeCommand } from "./software-change.js";
import { validateSigilCommand, validateWorkflowCommand } from "./validation.js";
import { dashboardCommand } from "./dashboard.js";
import { profileCommand } from "./profile.js";
import { configCommand } from "./config.js";

export type CommandHandler = (args: string[]) => Promise<number>;

export const commandHandlers: Record<CommandName, CommandHandler> = {
  config: configCommand,
  dashboard: dashboardCommand,
  profile: profileCommand,
  "task-graph": taskGraphCommand,
  migrate: migrateCommand,
  refactor: refactorCommand,
  probe: probeCommand,
  plan: planCommand,
  "software-change": softwareChangeCommand,
  implement: implementCommand,
  review: reviewCommand,
  breakdown: breakdownCommand,
  dispatch: dispatchCommand,
  "validate-workflow": validateWorkflowCommand,
  "validate-sigil": validateSigilCommand,
  "run-workflow": runWorkflowCommand,
  "run-sigil": runSigilCommand,
  setup: setupCommand,
  "discover-env": discoverEnvCommand,
};
