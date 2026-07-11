import type { CommandName } from "../help.js";
import { discoverEnvCommand } from "./environment.js";
import { breakdownCommand, dispatchCommand, migrateCommand, probeCommand, refactorCommand } from "./repository-programs.js";
import { runSigilCommand, runWorkflowCommand } from "./run.js";
import { setupCommand } from "./setup.js";
import { implementCommand, planCommand, reviewCommand, softwareChangeCommand } from "./software-change.js";
import { validateCommand, validateSigilCommand, validateWorkflowCommand } from "./validation.js";

export type CommandHandler = (args: string[]) => Promise<number>;

export const commandHandlers: Record<CommandName, CommandHandler> = {
  migrate: migrateCommand,
  refactor: refactorCommand,
  probe: probeCommand,
  plan: planCommand,
  "software-change": softwareChangeCommand,
  implement: implementCommand,
  review: reviewCommand,
  breakdown: breakdownCommand,
  dispatch: dispatchCommand,
  validate: validateCommand,
  "validate-workflow": validateWorkflowCommand,
  "validate-sigil": validateSigilCommand,
  "run-workflow": runWorkflowCommand,
  "run-sigil": runSigilCommand,
  setup: setupCommand,
  "discover-env": discoverEnvCommand,
};
