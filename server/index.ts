import type { Server } from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { UserStore } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createApp } from "./http.ts";
import { LoginLimiter } from "./rate-limit.ts";
import { Relay } from "./relay.ts";
import { SessionStore } from "./sessions.ts";
import { attachWebSockets } from "./ws.ts";

const HOUR_MS = 60 * 60 * 1000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

const config = loadConfig();
const db = openDatabase(path.join(config.dataDir, "hako.db"));
const users = new UserStore(db);
const sessions = new SessionStore(db, config.sessionSecret);
const limiter = new LoginLimiter(db);
const relay = new Relay({ log });

if (await users.ensure(config.ownerEmail, config.initialPassword)) {
  log("created the owner account from HAKO_OWNER_EMAIL and HAKO_INITIAL_PASSWORD");
}

const app = createApp({
  config,
  users,
  sessions,
  limiter,
  onSessionsEnded: (hashes) => relay.closeSessions(hashes),
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  log(`listening on port ${info.port}, serving ${config.origins.join(", ")}`);
}) as Server;
attachWebSockets(server, { config, relay, sessions });

const pruneTimer = setInterval(() => {
  sessions.prune();
  limiter.prune();
}, HOUR_MS);
pruneTimer.unref();

function shutdown(): void {
  log("shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
