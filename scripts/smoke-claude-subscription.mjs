#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { agent } from "../src/agents.ts";
import { processGroupHasLiveMembers } from "../src/process-identity.ts";

const binding = {
  provider: "claude",
  model: "sonnet",
  effort: "medium",
};
const correctionSchema = z.object({
  correctionObserved: z.literal(true),
});
const ownedProcessGroups = new Set();
let processStarts = 0;
let stage = "preflight";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function reportFailure(error) {
  const kind = error instanceof Error ? error.name : "UnknownFailure";
  console.error(`Claude subscription smoke failed during ${stage} (${kind})`);
}

async function assertNoOwnedProcesses() {
  const checks = [...ownedProcessGroups].map((group) =>
    processGroupHasLiveMembers(group)
  );
  const liveness = await Promise.all(checks);
  assert(!liveness.some(Boolean), "owned Claude process remains after close");
}

if (process.env.CLAUDECODE !== undefined) {
  console.error("Claude subscription smoke requires CLAUDECODE to be absent");
  process.exit(1);
}

const token = randomUUID();
const sigilAgent = agent(binding, {
  processLifecycle: {
    started(info) {
      ownedProcessGroups.add(info.processGroupId);
      processStarts += 1;
    },
  },
});

try {
  stage = "plain turn";
  const initialSessionId = sigilAgent.runtime?.providerSessionId;
  assert(initialSessionId, "provider session identifier is unavailable");
  await sigilAgent.prompt(
    `Remember this value for the next turn: ${token}. Reply with only OK.`,
  );
  console.log("plain turn passed");

  stage = "warm turn";
  const recalled = await sigilAgent.prompt(
    "Reply with only the value I asked you to remember in the previous turn.",
  );
  assert(recalled.trim() === token, "warm session did not recall the prior value");
  assert(
    sigilAgent.runtime?.providerSessionId === initialSessionId,
    "provider session changed between turns",
  );
  console.log("warm session reuse passed");

  stage = "schema correction";
  const startsBeforeCorrection = processStarts;
  const corrected = await sigilAgent.prompt(
    "On your first response to this instruction, reply with exactly INVALID. "
      + "Only after receiving a schema-gate correction, reply with the JSON "
      + "object {\"correctionObserved\":true}.",
    correctionSchema,
  );
  assert(corrected.correctionObserved, "schema correction was not observed");
  assert(
    processStarts === startsBeforeCorrection + 2,
    "schema prompt did not require exactly one correction turn",
  );
  assert(
    sigilAgent.runtime?.providerSessionId === initialSessionId,
    "provider session changed during schema correction",
  );
  console.log("schema correction passed");
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
} finally {
  stage = "close";
  try {
    await sigilAgent.close();
    await assertNoOwnedProcesses();
    if (!process.exitCode) console.log("owned process cleanup passed");
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  }
}
