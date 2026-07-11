import type { SigilConfig } from "./config.js";
import type { SigilContext } from "./context.js";
import { isCleanTree } from "./git.js";

export async function bootstrapWorkspace(
  ctx: SigilContext,
  repo: string,
  config: SigilConfig,
): Promise<void> {
  const command = config.workspace.bootstrap;
  if (!command) return;

  await ctx.observe("workspace-bootstrap-started", { command });
  const result = await ctx.sh(command);
  await ctx.observe("workspace-bootstrap-completed", {
    command,
    exitCode: result.exitCode === null ? "unknown" : String(result.exitCode),
  });

  if (!result.ok) {
    const log = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`workspace bootstrap failed: ${log || result.message}`);
  }

  if (!(await isCleanTree(repo))) {
    throw new Error("workspace bootstrap changed tracked repository files");
  }
}
