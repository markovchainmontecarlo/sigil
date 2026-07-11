import { resolve } from "node:path";

import { codexAcpAvailable, copilotCliAvailable, copilotSdkAvailable } from "../agents.js";
import { loadConfig } from "../config.js";
import { parseCommandArgs, rejectPositionals, value } from "./parse.js";

export async function discoverEnvCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    repo: { type: "string" },
  });
  rejectPositionals(parsed);

  const repo = resolve(value(parsed, "repo") ?? process.cwd());
  try {
    const config = loadConfig(repo);
    for (const [name, binding] of Object.entries(config.agents)) {
      const effort = binding.effort === undefined ? "" : ` effort=${binding.effort}`;
      console.log(`agent ${name}: provider=${binding.provider} model=${binding.model}${effort}`);
    }
    console.log(`codex acp available: ${codexAcpAvailable()}`);
    console.log(`claude auth source: ${process.env.ANTHROPIC_API_KEY ? "api billing" : "subscription"}`);
    console.log(`copilot cli available: ${copilotCliAvailable()}`);
    console.log(`copilot sdk available: ${copilotSdkAvailable()}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
