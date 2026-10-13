import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, test } from "node:test";
import { UserStore } from "../server/auth.ts";
import type { Config } from "../server/config.ts";
import { openDatabase } from "../server/db.ts";
import { createApp } from "../server/http.ts";
import { loadVapidKeys, PushService, PushStore, readSubscription } from "../server/push.ts";
import { LoginLimiter } from "../server/rate-limit.ts";
import { SessionStore } from "../server/sessions.ts";
import type { NotifyEvent } from "../shared/notify.ts";

// A stand-in for a push service: it keeps what it is sent and answers with the status it is told.

type Received = { path: string; headers: IncomingHttpHeaders; body: Buffer };

let server: Server;
let origin = "";
let received: Received[] = [];
let answer = 201;

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(answer, { "Content-Type": "application/json" });
      response.end(answer >= 400 ? '{"reason":"Unregistered"}' : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  received = [];
  answer = 201;
});

// A stand-in for a browser: the key pair and the secret of one push subscription.

function browser(name: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: `${origin}/push/${name}-${randomBytes(12).toString("base64url")}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  };
}

/** Decrypts an `aes128gcm` push message as the browser would (RFC 8291). */
function decrypt(device: ReturnType<typeof browser>, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const keyLength = body[20];
  const serverKey = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const shared = device.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    device.ecdh.getPublicKey(),
    serverKey,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, device.auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last record ends with a 0x02 and then padding.
  return plain.subarray(0, plain.lastIndexOf(0x02)).toString("utf8");
}

/** Checks the VAPID header's signature against the relay's public key and returns its claims. */
function vapidClaims(header: string, publicKey: string): Record<string, unknown> {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, "an Authorization header in the vapid scheme");
  assert.equal(match[2], publicKey);
  const [head, claims, signature] = match[1].split(".");
  const point = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const signed = verify(
    "sha256",
    Buffer.from(`${head}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  assert.ok(signed, "the token is signed by the relay's key");
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
}

type Json = Record<string, any>;

async function json(response: Response | Promise<Response>): Promise<Json> {
  return (await (await response).json()) as Json;
}

const SECRET = "a-test-secret-that-is-long-enough";
const APP_ORIGIN = "http://localhost:8787";

function relay(options: { secure?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const sessions = new SessionStore(db, SECRET);
  const store = new PushStore(db);
  const logs: string[] = [];
  const vapid = loadVapidKeys(db, null);
  const push = new PushService({
    store,
    vapid,
    subject: "mailto:owner@example.com",
    log: (line) => logs.push(line),
    timeoutMs: 2_000,
  });
  const ended: string[] = [];
  const config = {
    origins: [APP_ORIGIN],
    secureCookies: options.secure ?? false,
    clientDir: path.resolve("public"),
  } as Config;
  const app = createApp({
    config,
    users: new UserStore(db),
    sessions,
    limiter: new LoginLimiter(db),
    pushStore: store,
    push,
    onSessionsEnded: (hashes) => {
      ended.push(...hashes);
      store.removeForSessions(hashes);
    },
  });
  const cookieName = options.secure ? "__Host-hako_session" : "hako_session";
  const login = () => {
    const session = sessions.create();
    const call = (route: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: `${cookieName}=${session.cookie}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: APP_ORIGIN }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { hash: session.idHash, call };
  };
  return { db, app, sessions, store, push, vapid, logs, login };
}

const WAITING: NotifyEvent = {
  kind: "agent_waiting",
  title: "Claude Code is waiting",
  body: "Allow Bash: pnpm test?",
  session_id: "sess-0007",
  tab_id: "tab-0003",
};

test("a subscription is stored for the session, and a notification arrives encrypted and signed", async () => {
  const { login, push, store, vapid } = relay();
  const phone = browser("phone");
  const device = login();

  assert.deepEqual(await json(device.call("/api/push/key")), { key: vapid.publicKey });
  assert.deepEqual(await json(device.call("/api/push/device")), { subscribed: false });

  const saved = await device.call("/api/push/subscribe", phone.subscription);
  assert.equal(saved.status, 200);
  const state = await json(saved);
  assert.equal(state.subscribed, true);
  assert.equal(state.muted, false);
  assert.deepEqual(state.kinds, { agent_waiting: true, agent_done: true, command_done: true });
  assert.deepEqual(await json(device.call("/api/push/device")), state);
  assert.equal(store.count(), 1);

  push.notify(WAITING);
  await push.settled();

  assert.equal(received.length, 1);
  const [request] = received;
  assert.equal(`${origin}${request.path}`, phone.subscription.endpoint);
  assert.equal(request.headers["content-encoding"], "aes128gcm");
  assert.equal(request.headers.ttl, "14400");
  assert.equal(request.headers.urgency, "high");
  assert.match(String(request.headers.topic), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Number(request.headers["content-length"]), request.body.length);

  const claims = vapidClaims(String(request.headers.authorization), vapid.publicKey);
  assert.equal(claims.aud, origin);
  assert.equal(claims.sub, "mailto:owner@example.com");
  assert.ok(Number(claims.exp) > Date.now() / 1000);

  assert.ok(!request.body.includes("Claude Code"), "the text does not travel in the clear");
  assert.deepEqual(JSON.parse(decrypt(phone, request.body)), {
    v: 1,
    kind: "agent_waiting",
    title: "Claude Code is waiting",
    body: "Allow Bash: pnpm test?",
    session_id: "sess-0007",
    tab_id: "tab-0003",
    tag: "hako:sess-0007",
  });
});

test("a subscription the push service reports as gone is removed, and any other failure keeps it", async () => {
  for (const status of [404, 410]) {
    const { login, push, store, logs } = relay();
    await login().call("/api/push/subscribe", browser("phone").subscription);
    answer = status;
    push.notify(WAITING);
    await push.settled();
    assert.equal(store.count(), 0, `a ${status} removes the subscription`);
    assert.match(logs.join("\n"), /is gone/);
  }

  const { login, push, store, logs } = relay();
  await login().call("/api/push/subscribe", browser("phone").subscription);
  for (const status of [403, 429, 500]) {
    answer = status;
    push.notify(WAITING);
    await push.settled();
  }
  assert.equal(store.count(), 1);
  assert.match(logs.join("\n"), /answered 403 \{"reason":"Unregistered"\}/);
});

test("a push service that cannot be reached is logged and nothing is thrown", async () => {
  const { login, push, store, logs } = relay();
  const phone = browser("phone");
  // Nothing listens on port 9, so the connection is refused.
  phone.subscription.endpoint = "http://127.0.0.1:9/push/unreachable";
  await login().call("/api/push/subscribe", phone.subscription);
  push.notify(WAITING);
  await push.settled();
  assert.equal(store.count(), 1);
  assert.match(logs.join("\n"), /could not be reached/);
});

test("muted devices, and devices that turned a kind off, are left out", async () => {
  const { login, push } = relay();
  const all = { device: login(), phone: browser("all") };
  const muted = { device: login(), phone: browser("muted") };
  const noDone = { device: login(), phone: browser("no-done") };
  for (const { device, phone } of [all, muted, noDone]) {
    await device.call("/api/push/subscribe", phone.subscription);
  }
  const mutedState = await json(muted.device.call("/api/push/settings", { muted: true }));
  assert.equal(mutedState.muted, true);
  const kinds = await json(
    noDone.device.call("/api/push/settings", { kinds: { agent_done: false } }),
  );
  assert.deepEqual(kinds.kinds, { agent_waiting: true, agent_done: false, command_done: true });

  const reached = async (notification: NotifyEvent) => {
    received = [];
    push.notify(notification);
    await push.settled();
    return received.map((request) => request.path.split("/")[2].split("-")[0]).sort();
  };
  assert.deepEqual(await reached(WAITING), ["all", "no"]);
  assert.deepEqual(await reached({ ...WAITING, kind: "agent_done" }), ["all"]);
  assert.deepEqual(await reached({ ...WAITING, kind: "command_done" }), ["all", "no"]);

  // Other kinds are sent with normal urgency.
  assert.equal(received[0].headers.urgency, "normal");

  await muted.device.call("/api/push/settings", { muted: false });
  assert.deepEqual(await reached(WAITING), ["all", "muted", "no"]);
});

test("preferences come with a subscription, and survive its renewal", async () => {
  const { login } = relay();
  const device = login();
  const first = await device.call("/api/push/subscribe", {
    ...browser("phone").subscription,
    muted: true,
    kinds: { command_done: false },
  });
  const state = await json(first);
  assert.equal(state.muted, true);
  assert.deepEqual(state.kinds, { agent_waiting: true, agent_done: true, command_done: false });

  const again = await device.call("/api/push/subscribe", browser("phone").subscription);
  const renewed = await json(again);
  assert.notEqual(renewed.endpoint_id, state.endpoint_id);
  assert.equal(renewed.muted, true);
  assert.equal(renewed.kinds.command_done, false);
});

test("a device is forgotten when it unsubscribes, logs out or its session ends", async () => {
  const { login, push, store, sessions } = relay();
  const one = login();
  await one.call("/api/push/subscribe", browser("one").subscription);
  assert.deepEqual(await json(one.call("/api/push/unsubscribe", {})), { ok: true });
  assert.equal(store.count(), 0);

  await one.call("/api/push/subscribe", browser("one").subscription);
  await one.call("/api/logout", {});
  assert.equal(store.count(), 0);

  const two = login();
  await two.call("/api/push/subscribe", browser("two").subscription);
  sessions.delete(two.hash);
  push.notify(WAITING);
  await push.settled();
  assert.equal(received.length, 0, "a session that ended gets nothing");
  store.prune();
  assert.equal(store.count(), 0);
});

test("a test notification goes to this device only, muted or not, and reports a failure", async () => {
  const { login } = relay();
  const mine = { device: login(), phone: browser("mine") };
  const other = { device: login(), phone: browser("other") };
  await mine.device.call("/api/push/subscribe", { ...mine.phone.subscription, muted: true });
  await other.device.call("/api/push/subscribe", other.phone.subscription);

  const sent = await mine.device.call("/api/push/test", {});
  assert.deepEqual(await json(sent), { ok: true });
  assert.equal(received.length, 1);
  assert.match(received[0].path, /^\/push\/mine-/);
  const payload = JSON.parse(decrypt(mine.phone, received[0].body));
  assert.equal(payload.kind, "test");
  assert.equal(payload.session_id, null);

  answer = 403;
  const refused = await mine.device.call("/api/push/test", {});
  assert.equal(refused.status, 502);
  assert.deepEqual(await json(refused), {
    error: "push_failed",
    status: 403,
    reason: '{"reason":"Unregistered"}',
  });

  answer = 410;
  assert.equal((await mine.device.call("/api/push/test", {})).status, 410);
  assert.equal((await mine.device.call("/api/push/test", {})).status, 404);
});

test("the push routes need a session, and the ones that change something need the app's origin", async () => {
  const { app, login, store } = relay();
  const phone = browser("phone");
  for (const route of ["/api/push/key", "/api/push/device"]) {
    assert.equal((await app.request(route)).status, 401);
  }
  for (const route of ["subscribe", "settings", "unsubscribe", "test"]) {
    const anonymous = await app.request(`/api/push/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify(phone.subscription),
    });
    assert.equal(anonymous.status, 401, route);
    const foreign = await login().call(`/api/push/${route}`, phone.subscription, {
      Origin: "https://elsewhere.example",
    });
    assert.equal(foreign.status, 403, route);
  }
  assert.equal(store.count(), 0);

  const device = login();
  assert.equal((await device.call("/api/push/settings", { muted: true })).status, 404);
  assert.equal((await device.call("/api/push/test", {})).status, 404);
  for (const bad of [
    {},
    { endpoint: "not a url", keys: phone.subscription.keys },
    { endpoint: phone.subscription.endpoint, keys: { p256dh: "AAAA", auth: "AAAA" } },
    { ...phone.subscription, muted: "yes" },
    { ...phone.subscription, kinds: { agent_done: 1 } },
  ]) {
    assert.equal((await device.call("/api/push/subscribe", bad)).status, 400);
  }
  assert.equal(store.count(), 0);
});

test("only an HTTPS endpoint is taken, except plain HTTP to this computer in development", () => {
  const { subscription } = browser("phone");
  const https = { ...subscription, endpoint: "https://web.push.apple.com/QOabc" };
  assert.ok(readSubscription(https, false));
  assert.equal(readSubscription(subscription, false), null);
  assert.ok(readSubscription(subscription, true));
  assert.equal(readSubscription({ ...https, endpoint: "http://10.0.0.5/push" }, true), null);
  assert.equal(
    readSubscription({ ...https, endpoint: "https://user:pw@example.com/p" }, true),
    null,
  );
  assert.equal(readSubscription({ ...https, endpoint: "file:///etc/passwd" }, true), null);
});

test("nothing that identifies or unlocks a subscription reaches the log", async () => {
  const { login, push, logs, vapid } = relay();
  const phone = browser("phone");
  await login().call("/api/push/subscribe", phone.subscription);
  for (const status of [201, 500, 410]) {
    answer = status;
    push.notify(WAITING);
    await push.settled();
  }
  const text = logs.join("\n");
  assert.ok(text.length > 0);
  for (const secret of [
    phone.subscription.keys.p256dh,
    phone.subscription.keys.auth,
    new URL(phone.subscription.endpoint).pathname,
    vapid.privateKey,
  ]) {
    assert.ok(!text.includes(secret));
  }
});

test("the VAPID keys are made once and kept in the database, unless the environment gives a pair", () => {
  const db = openDatabase(":memory:");
  const first = loadVapidKeys(db, null);
  assert.equal(Buffer.from(first.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(first.privateKey, "base64url").length, 32);
  assert.deepEqual(loadVapidKeys(db, null), first);
  const given = { publicKey: "from-the-environment", privateKey: "also" };
  assert.deepEqual(loadVapidKeys(db, given), given);
  assert.deepEqual(loadVapidKeys(db, null), first);
});

test("a database from before notifications gains the new columns and keeps its rows", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hako-db-")), "hako.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL,
      password_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL);
    CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL,
      auth TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'owner@example.com', 'hash', 1);
    INSERT INTO sessions VALUES ('abc', 1, 9999999999999);
    INSERT INTO push_subscriptions VALUES ('https://push.example/1', 'p', 'a', 1);
  `);
  old.close();

  for (let start = 0; start < 2; start++) {
    const db = openDatabase(file);
    assert.equal(new UserStore(db).get()?.email, "owner@example.com");
    assert.ok(new SessionStore(db, SECRET).isLive("abc"));
    const row = db.prepare("SELECT * FROM push_subscriptions").get()!;
    assert.equal(row.endpoint, "https://push.example/1");
    assert.equal(row.session_hash, null);
    assert.equal(row.muted, 0);
    assert.equal(row.on_agent_waiting, 1);
    // A row no session owns is never sent to.
    assert.deepEqual(new PushStore(db).wanting("agent_waiting"), []);
    db.close();
  }
  fs.rmSync(path.dirname(file), { recursive: true });
});
