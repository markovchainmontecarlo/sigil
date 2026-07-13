import { writeFile } from "node:fs/promises";

import { RunStore } from "./runs.js";
import { acceptRun } from "./sigil-server.js";
import { workOnce } from "./worker.js";

const store = new RunStore();
acceptRun(store, { runId: "normal" });
if (store.record("normal").transitions.join(",") !== "accepted,queued") throw new Error("workflow started in handler");
await workOnce(store);

acceptRun(store, { runId: "cancelled", cancelRequested: true });
await workOnce(store);

const normal = store.record("normal");
const cancelled = store.record("cancelled");
await writeFile(process.argv[2], JSON.stringify({
  runtime: "node",
  normal: {
    transitions: normal.transitions,
    events: normal.events.map((event) => [event.sequence, event.stage]),
    status: normal.terminals[0]?.status,
    terminalCount: normal.terminals.length,
  },
  cancelled: {
    transitions: cancelled.transitions,
    events: cancelled.events.map((event) => [event.sequence, event.stage]),
    status: cancelled.terminals[0]?.status,
    terminalCount: cancelled.terminals.length,
  },
}));
