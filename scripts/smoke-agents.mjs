#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { agent } from "../src/agents.ts";

const token = `sigil-${randomUUID()}`;
const sigilAgent = agent({ provider: "codex", model: "gpt-5.5" });

try {
  await sigilAgent.prompt(`Remember this exact token for the next turn: ${token}. Reply with only OK.`);
  const recalled = await sigilAgent.prompt("Reply with only the exact token I asked you to remember in the previous turn.");
  if (!recalled.includes(token)) {
    throw new Error(`Warm context failed: expected ${token}, got ${JSON.stringify(recalled)}`);
  }
  console.log(`turn-2 recalled ${token}`);
} finally {
  await sigilAgent.close();
}

await new Promise((resolve) => setTimeout(resolve, 500));
let pgrep = "";
try {
  pgrep = execSync("pgrep -fl codex-acp", { encoding: "utf8" }).trim();
} catch (error) {
  if (error.status !== 1) throw error;
}

if (pgrep) {
  console.error(`codex-acp processes remain:\n${pgrep}`);
  process.exit(1);
}

console.log("codex-acp processes after close: 0");
