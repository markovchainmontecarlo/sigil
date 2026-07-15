#!/usr/bin/env bun
import { commandHandlers } from "./commands/index.js";
import {
  detachedCommandNames,
  launchDetachedCommand,
  requestsForeground,
  runDetachedCommandWorker,
  withoutForeground,
} from "./command-runner.js";
import { isUsageError, printUnhandledError } from "./commands/errors.js";
import { isCommandName, renderCommandHelp, renderGlobalHelp } from "./help.js";
import { runTypeScriptSigilWorker } from "./sigil-runner.js";

function printUsage(): 2 {
  console.error(renderGlobalHelp());
  return 2;
}

function printGlobalHelp(): 0 {
  console.log(renderGlobalHelp());
  return 0;
}

function printCommandHelp(command: string): 0 | 2 {
  if (!isCommandName(command)) return printUsage();
  console.log(renderCommandHelp(command));
  return 0;
}

async function runCommand(command: string, args: string[]): Promise<number> {
  if (!isCommandName(command)) return printUsage();
  return commandHandlers[command](args);
}

async function runPublicCommand(command: string, args: string[]): Promise<number> {
  if (!isCommandName(command)) return printUsage();
  if (!detachedCommandNames.has(command)) return runCommand(command, args);
  if (requestsForeground(args)) return runCommand(command, withoutForeground(args));

  const handle = await launchDetachedCommand(command, args);
  console.log(JSON.stringify(handle, null, 2));
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  try {
    if (!command) return printUsage();
    if (command === "__run-sigil-worker") {
      const manifestIndex = args.indexOf("--manifest");
      const manifest = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
      if (!manifest) throw new Error("missing detached Sigil worker manifest");
      await runTypeScriptSigilWorker(manifest);
      return 0;
    }
    if (command === "__run-command-worker") {
      const manifestIndex = args.indexOf("--manifest");
      const manifest = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
      if (!manifest) throw new Error("missing detached command worker manifest");
      await runDetachedCommandWorker(manifest, runCommand);
      return 0;
    }
    if (command === "--help" || command === "-h") return printGlobalHelp();
    if (args.includes("--help") || args.includes("-h")) return printCommandHelp(command);
    return await runPublicCommand(command, args);
  } catch (error) {
    if (isUsageError(error)) return printUsage();
    printUnhandledError(error);
    return 1;
  }
}

if (import.meta.main === true) process.exit(await main());
