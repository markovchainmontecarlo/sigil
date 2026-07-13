import { resolve } from "node:path";

import { defaultDashboardRoots } from "../dashboard/discovery.js";
import { startDashboardServer } from "../dashboard/server.js";
import { UsageError } from "./errors.js";
import { parseCommandArgs, rejectPositionals, repeatedValues, value } from "./parse.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export async function dashboardCommand(args: string[]): Promise<number> {
  const parsed = parseCommandArgs(args, {
    host: { type: "string" },
    port: { type: "string" },
    root: { type: "string", multiple: true },
  });
  rejectPositionals(parsed);

  const host = value(parsed, "host") ?? "127.0.0.1";
  const port = parsePort(value(parsed, "port"));
  const roots = [
    ...defaultDashboardRoots(),
    resolve(process.cwd()),
    ...(repeatedValues(parsed, "root") ?? []).map((root) => resolve(root)),
  ];
  if (!LOOPBACK_HOSTS.has(host)) throw new UsageError("dashboard host must be a loopback address");

  const dashboard = startDashboardServer({ host, port, roots });
  console.log(dashboard.url);
  await waitForShutdown();
  dashboard.stop();
  return 0;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 4317;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError("dashboard port must be an integer from 0 to 65535");
  return port;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}
