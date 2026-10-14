import { createServer } from "node:http";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { UserStore } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createApp } from "./http.ts";
import { NotifyGate } from "./notify.ts";
import { TicketStore } from "./previews/access.ts";
import { PreviewProxy } from "./previews/proxy.ts";
import { loadVapidKeys, PushService, PushStore } from "./push.ts";
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
const pushStore = new PushStore(db);
const push = new PushService({
  store: pushStore,
  vapid: loadVapidKeys(db, config.vapidKeys),
  subject: config.vapidSubject,
  log,
});
// A notification goes to the clients that are open and, as a push, to the devices that want it.
const notifyGate: NotifyGate = new NotifyGate({
  deliver: (notification) => {
    relay.sendEvent("notify", notification);
    push.notify(notification);
  },
  log,
});
const relay = new Relay({ log, onNotify: (data) => notifyGate.accept(data) });

if (await users.ensure(config.ownerEmail, config.initialPassword)) {
  log("created the owner account from HAKO_OWNER_EMAIL and HAKO_INITIAL_PASSWORD");
}

const tickets = new TicketStore();
const previews = config.previews
  ? new PreviewProxy({ config, relay, sessions, tickets, log })
  : null;

const app = createApp({
  config,
  users,
  sessions,
  limiter,
  pushStore,
  push,
  tickets,
  onSessionsEnded: (hashes) => {
    relay.closeSessions(hashes);
    previews?.closeSessions(hashes);
    pushStore.removeForSessions(hashes);
  },
});

const appListener = getRequestListener(app.fetch);
// A request for a preview origin never reaches the app's routes, and the reverse.
const server = createServer((request, response) => {
  const target = previews?.target(request);
  if (previews && target && target.kind !== "app") {
    previews.handleRequest(request, response, target);
  } else {
    void appListener(request, response);
  }
});
attachWebSockets(server, { config, relay, sessions, previews });
server.listen(config.port, () => {
  const where = config.previews
    ? `, previews under *.${config.previews.domain}`
    : ", previews off (no preview domain)";
  log(`listening on port ${config.port}, serving ${config.origins.join(", ")}${where}`);
});

const pruneTimer = setInterval(() => {
  sessions.prune();
  limiter.prune();
  pushStore.prune();
}, HOUR_MS);
pruneTimer.unref();

function shutdown(): void {
  log("shutting down");
  relay.streams.dispose();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
