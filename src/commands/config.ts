import { resolve } from "node:path";

import { resolveConfig } from "../config.js";
import { projectEffectiveConfig, renderEffectiveConfig } from "../effective-config.js";
import { UsageError } from "./errors.js";
import { printJson } from "./output.js";
import { parseCommandArgs, value } from "./parse.js";

export async function configCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    effective: { type: "boolean" },
    repo: { type: "string" },
    json: { type: "boolean" },
  });
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "show") {
    throw new UsageError("expected config show");
  }
  if (parsed.values.effective !== true) throw new UsageError("config show requires --effective");

  const repo = resolve(value(parsed, "repo") ?? process.cwd());
  const effective = projectEffectiveConfig(resolveConfig(repo));
  if (parsed.values.json === true) printJson(effective);
  else console.log(renderEffectiveConfig(effective));
  return 0;
}
