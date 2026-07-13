import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDashboardSnapshotReader } from "./snapshot.js";
import { createArchiveStore } from "./archive-store.js";
import type { DashboardSnapshot } from "./types.js";

export type DashboardServerOptions = {
  host: string;
  port: number;
  roots: string[];
  refreshMs?: number;
  archiveFile?: string;
};

export type DashboardServer = {
  url: string;
  stop(): void;
};

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function startDashboardServer(options: DashboardServerOptions): DashboardServer {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let latest: DashboardSnapshot | undefined;
  let digest = "";
  let refreshing = false;
  let snapshotPromise: Promise<DashboardSnapshot> | undefined;
  const readSnapshot = createDashboardSnapshotReader(options.roots);
  const archives = createArchiveStore(options.archiveFile ?? join(homedir(), ".sigil", "dashboard", "archives.json"));

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/archive") return await updateArchive(request);
      if (request.method !== "GET") return response("Method not allowed", 405, "text/plain");

      if (path === "/healthz") return response("ok\n", 200, "text/plain");
      if (path === "/api/snapshot") return json(latest ?? await loadSnapshot());
      if (path === "/api/history") return json(await withArchives(await readSnapshot("history"), false));
      if (path === "/api/events") return eventStream(clients, encoder, () => latest);
      if (path === "/favicon.ico") return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      if (path === "/") return asset("index.html", "text/html; charset=utf-8");
      if (path === "/dashboard.css") return asset("dashboard.css", "text/css; charset=utf-8");
      if (path === "/dashboard.js") return asset("dashboard.js", "text/javascript; charset=utf-8");
      return response("Not found", 404, "text/plain");
    },
  });

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await publishChangedSnapshot();
    } finally {
      refreshing = false;
    }
  };

  const publishChangedSnapshot = async () => {
    const next = await loadSnapshot();
    const nextDigest = JSON.stringify({ runs: next.runs, profiles: next.profiles });
    if (nextDigest === digest) return;
    digest = nextDigest;
    latest = next;
    const message = encoder.encode(`event: snapshot\ndata: ${JSON.stringify(next)}\n\n`);
    for (const client of clients) {
      try {
        client.enqueue(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  const timer = setInterval(() => void refresh(), options.refreshMs ?? 2_000);
  void refresh();

  async function loadSnapshot(): Promise<DashboardSnapshot> {
    snapshotPromise ??= readSnapshot("current").then((snapshot) => withArchives(snapshot, true));
    try {
      return await snapshotPromise;
    } finally {
      snapshotPromise = undefined;
    }
  }

  async function withArchives(snapshot: DashboardSnapshot, hideArchived: boolean): Promise<DashboardSnapshot> {
    const runIds = await archives.list();
    const runs = snapshot.runs
      .map((run) => ({ ...run, archived: runIds.has(run.id) }))
      .filter((run) => !hideArchived || !run.archived);
    return { ...snapshot, runs };
  }

  async function updateArchive(request: Request): Promise<Response> {
    const value = await request.json().catch(() => undefined) as { id?: unknown; archived?: unknown } | undefined;
    if (!value || typeof value.id !== "string" || typeof value.archived !== "boolean") {
      return response("Invalid archive request", 400, "text/plain");
    }
    const current = latest ?? await loadSnapshot();
    const run = current.runs.find((candidate) => candidate.id === value.id);
    if (value.archived && run && ["running", "waiting", "starting"].includes(run.health.state)) {
      return response("Active runs cannot be archived", 409, "text/plain");
    }
    await archives.set(value.id, value.archived);
    latest = undefined;
    digest = "";
    await refresh();
    return json({ id: value.id, archived: value.archived });
  }

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop() {
      clearInterval(timer);
      for (const client of clients) {
        try {
          client.close();
        } catch {}
      }
      clients.clear();
      server.stop(true);
    },
  };
}

function eventStream(
  clients: Set<ReadableStreamDefaultController<Uint8Array>>,
  encoder: TextEncoder,
  latest: () => DashboardSnapshot | undefined,
): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(current) {
      controller = current;
      clients.add(current);
      const snapshot = latest();
      if (snapshot) current.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
    },
    cancel() {
      if (controller) clients.delete(controller);
    },
  });
  return new Response(stream, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
    },
  });
}

async function asset(name: string, contentType: string): Promise<Response> {
  return response(await readFile(join(PUBLIC_DIR, name)), 200, contentType);
}

function json(value: unknown): Response {
  return response(`${JSON.stringify(value)}\n`, 200, "application/json; charset=utf-8");
}

function response(body: string | Uint8Array, status: number, contentType: string): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": contentType } });
}
