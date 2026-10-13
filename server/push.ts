import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import webpush from "web-push";
import {
  DEFAULT_NOTIFY_PREFS,
  type DeviceState,
  NOTIFY_KINDS,
  type NotifyEvent,
  type NotifyKind,
  type NotifyPrefs,
  notifyTag,
  type PushPayload,
} from "../shared/notify.ts";

export type VapidKeys = { publicKey: string; privateKey: string };

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export type Subscription = { endpoint: string; p256dh: string; auth: string };

type StoredSubscription = Subscription & { prefs: NotifyPrefs };

export type SendResult =
  | { ok: true }
  /** `status` is null when the push service could not be reached at all. */
  | { ok: false; status: number | null; reason: string; gone: boolean };

const MAX_ENDPOINT_LENGTH = 2048;
const P256_POINT_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
/** A push message may carry about 4 kB once encrypted; this leaves room for that. */
const MAX_PAYLOAD_BYTES = 3072;
const SEND_TIMEOUT_MS = 10_000;
/** How long a push service keeps a message for a device it cannot reach, in seconds. */
const TTL_SECONDS = 4 * 60 * 60;

const KIND_COLUMNS: Record<NotifyKind, string> = {
  agent_waiting: "on_agent_waiting",
  agent_done: "on_agent_done",
  command_done: "on_command_done",
};

/** A stable name for an endpoint that does not give the endpoint away. */
export function endpointId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function decodeKey(value: unknown, bytes: number): string | null {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_\-+/]+=*$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes ? decoded.toString("base64url") : null;
}

/**
 * Reads a subscription from a request body: `{ endpoint, keys: { p256dh, auth } }`. Returns null
 * unless the endpoint is an HTTPS address and the keys have the sizes Web Push uses. Plain HTTP to
 * this computer is let through for a relay that is itself served without TLS, which is how a
 * development setup tests against a local stand-in for a push service.
 */
export function readSubscription(body: unknown, allowLocalHttp: boolean): Subscription | null {
  if (typeof body !== "object" || body === null) return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  if (typeof keys !== "object" || keys === null) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const allowed =
    url.protocol === "https:" || (allowLocalHttp && local && url.protocol === "http:");
  if (!allowed || url.username !== "" || url.password !== "") return null;
  const p256dh = decodeKey((keys as Record<string, unknown>).p256dh, P256_POINT_BYTES);
  const auth = decodeKey((keys as Record<string, unknown>).auth, AUTH_SECRET_BYTES);
  if (p256dh === null || auth === null) return null;
  if (Buffer.from(p256dh, "base64url")[0] !== 0x04) return null;
  return { endpoint, p256dh, auth };
}

/**
 * Reads the part of a request body that changes a device's preferences: `{ muted?, kinds? }`, with
 * `kinds` naming any of the kinds. Returns null when a value is not a boolean, and an empty object
 * when the body changes nothing.
 */
export function readPrefsChange(
  body: unknown,
): { muted?: boolean; kinds: Partial<Record<NotifyKind, boolean>> } | null {
  if (typeof body !== "object" || body === null) return null;
  const { muted, kinds } = body as { muted?: unknown; kinds?: unknown };
  if (muted !== undefined && typeof muted !== "boolean") return null;
  const change: Partial<Record<NotifyKind, boolean>> = {};
  if (kinds !== undefined) {
    if (typeof kinds !== "object" || kinds === null) return null;
    for (const kind of NOTIFY_KINDS) {
      const value = (kinds as Record<string, unknown>)[kind];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return null;
      change[kind] = value;
    }
  }
  return { ...(muted === undefined ? {} : { muted }), kinds: change };
}

/**
 * The VAPID key pair that identifies this relay to push services. One given in the environment
 * wins; otherwise the pair in the database is used, and made on the first start.
 */
export function loadVapidKeys(db: DatabaseSync, fromEnvironment: VapidKeys | null): VapidKeys {
  if (fromEnvironment) return fromEnvironment;
  const read = (key: string) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  };
  const publicKey = read("vapid_public_key");
  const privateKey = read("vapid_private_key");
  if (publicKey !== null && privateKey !== null) return { publicKey, privateKey };
  const created = webpush.generateVAPIDKeys();
  const write = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  write.run("vapid_public_key", created.publicKey);
  write.run("vapid_private_key", created.privateKey);
  return created;
}

/** The push subscriptions, one for each login session that enabled notifications. */
export class PushStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * Stores the subscription of a session's device, replacing any other the session had. Without
   * `prefs` the session's earlier preferences are kept, so a renewed subscription stays muted.
   */
  save(sessionHash: string, subscription: Subscription, prefs: NotifyPrefs | null): DeviceState {
    const kept = prefs ?? this.find(sessionHash)?.prefs ?? DEFAULT_NOTIFY_PREFS;
    this.db
      .prepare("DELETE FROM push_subscriptions WHERE session_hash = ? OR endpoint = ?")
      .run(sessionHash, subscription.endpoint);
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (endpoint, p256dh, auth, created_at, session_hash, muted,
            on_agent_waiting, on_agent_done, on_command_done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        this.now(),
        sessionHash,
        Number(kept.muted),
        Number(kept.kinds.agent_waiting),
        Number(kept.kinds.agent_done),
        Number(kept.kinds.command_done),
      );
    return this.state(sessionHash);
  }

  state(sessionHash: string): DeviceState {
    const found = this.find(sessionHash);
    if (!found) return { subscribed: false };
    return { subscribed: true, endpoint_id: endpointId(found.endpoint), ...found.prefs };
  }

  /** Changes a device's preferences. Returns null when the session has no subscription. */
  setPrefs(sessionHash: string, prefs: NotifyPrefs): DeviceState | null {
    const changed = this.db
      .prepare(
        `UPDATE push_subscriptions
            SET muted = ?, on_agent_waiting = ?, on_agent_done = ?, on_command_done = ?
          WHERE session_hash = ?`,
      )
      .run(
        Number(prefs.muted),
        Number(prefs.kinds.agent_waiting),
        Number(prefs.kinds.agent_done),
        Number(prefs.kinds.command_done),
        sessionHash,
      );
    return Number(changed.changes) > 0 ? this.state(sessionHash) : null;
  }

  find(sessionHash: string): StoredSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE session_hash = ?")
      .get(sessionHash);
    return row ? toStored(row) : null;
  }

  /** The devices a notification of this kind goes to: logged in, not muted, and wanting the kind. */
  wanting(kind: NotifyKind): StoredSubscription[] {
    return this.db
      .prepare(
        `SELECT p.* FROM push_subscriptions p
           JOIN sessions s ON s.id_hash = p.session_hash
          WHERE s.expires_at > ? AND p.muted = 0 AND p.${KIND_COLUMNS[kind]} = 1`,
      )
      .all(this.now())
      .map(toStored);
  }

  removeForSessions(sessionHashes: Iterable<string>): void {
    const remove = this.db.prepare("DELETE FROM push_subscriptions WHERE session_hash = ?");
    for (const sessionHash of sessionHashes) remove.run(sessionHash);
  }

  removeEndpoint(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  /** Removes the subscriptions whose login session has ended. */
  prune(): void {
    this.db
      .prepare(
        `DELETE FROM push_subscriptions
          WHERE session_hash IS NULL
             OR session_hash NOT IN (SELECT id_hash FROM sessions WHERE expires_at > ?)`,
      )
      .run(this.now());
  }

  count(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()?.n ?? 0);
  }
}

function toStored(row: Record<string, unknown>): StoredSubscription {
  return {
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    prefs: {
      muted: Number(row.muted) !== 0,
      kinds: {
        agent_waiting: Number(row.on_agent_waiting) !== 0,
        agent_done: Number(row.on_agent_done) !== 0,
        command_done: Number(row.on_command_done) !== 0,
      },
    },
  };
}

export type PushServiceOptions = {
  store: PushStore;
  vapid: VapidKeys;
  /** Whom a push service may write to about this relay: a `mailto:` or an `https:` address. */
  subject: string;
  log?: (message: string) => void;
  timeoutMs?: number;
};

function shortened(payload: PushPayload): string | null {
  let body = payload.body;
  for (;;) {
    const text = JSON.stringify({ ...payload, body });
    if (Buffer.byteLength(text) <= MAX_PAYLOAD_BYTES) return text;
    if (body === "") return null;
    const points = Array.from(body);
    body = points.length <= 8 ? "" : `${points.slice(0, points.length >> 1).join("")}…`;
  }
}

/** Encrypts notifications for the stored subscriptions and hands them to their push services. */
export class PushService {
  private readonly store: PushStore;
  private readonly vapid: VapidKeys;
  private readonly subject: string;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: PushServiceOptions) {
    this.store = options.store;
    this.vapid = options.vapid;
    this.subject = options.subject;
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  /**
   * Sends a notification to every device that wants its kind. Returns at once: the sending goes on
   * by itself, and a failure is logged, never thrown.
   */
  notify(notification: NotifyEvent): void {
    let devices: StoredSubscription[];
    try {
      devices = this.store.wanting(notification.kind);
    } catch (error) {
      this.log(`push: could not read the subscriptions: ${describe(error)}`);
      return;
    }
    if (devices.length === 0) return;
    const payload = shortened({
      v: 1,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      session_id: notification.session_id,
      tab_id: notification.tab_id,
      tag: notifyTag(notification.session_id),
    });
    if (payload === null) {
      this.log("push: dropped a notification that does not fit in a push message");
      return;
    }
    // A device that is offline is left one message for each terminal, the newest.
    const topic = createHash("sha256")
      .update(notification.session_id)
      .digest("base64url")
      .slice(0, 32);
    const urgency = notification.kind === "agent_waiting" ? "high" : "normal";
    for (const device of devices) {
      const sending = this.send(device, payload, { topic, urgency });
      this.inFlight.add(sending);
      void sending.finally(() => this.inFlight.delete(sending));
    }
  }

  /**
   * Sends a test to the device of one session, muted or not, and waits for the push service's
   * answer. Returns null when the session has no subscription.
   */
  async test(sessionHash: string): Promise<SendResult | null> {
    const device = this.store.find(sessionHash);
    if (!device) return null;
    const payload = JSON.stringify({
      v: 1,
      kind: "test",
      title: "Hako can reach this device",
      body: "This is where your Mac tells you that an agent is waiting or a command has finished.",
      session_id: null,
      tab_id: null,
      tag: "hako:test",
    } satisfies PushPayload);
    return this.send(device, payload, { urgency: "high" });
  }

  /** Resolves when every notification that was being sent has been answered or given up on. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async send(
    device: StoredSubscription,
    payload: string,
    options: { topic?: string; urgency: "high" | "normal" },
  ): Promise<SendResult> {
    const name = `${hostOf(device.endpoint)}#${endpointId(device.endpoint).slice(0, 8)}`;
    let request: { endpoint: string; headers: Record<string, unknown>; body: unknown };
    try {
      request = webpush.generateRequestDetails(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        {
          vapidDetails: {
            subject: this.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
          TTL: TTL_SECONDS,
          urgency: options.urgency,
          topic: options.topic,
          contentEncoding: "aes128gcm",
        },
      );
    } catch (error) {
      this.log(`push: could not encrypt for ${name}: ${describe(error)}`);
      return { ok: false, status: null, reason: "The message could not be encrypted", gone: false };
    }
    try {
      const headers: Record<string, string> = {};
      for (const [header, value] of Object.entries(request.headers)) {
        // The length is the HTTP client's to state.
        if (header.toLowerCase() !== "content-length") headers[header] = String(value);
      }
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers,
        body: new Uint8Array(request.body as Buffer),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) {
        await response.body?.cancel();
        return { ok: true };
      }
      const reason = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      const gone = response.status === 404 || response.status === 410;
      if (gone) {
        this.store.removeEndpoint(device.endpoint);
        this.log(`push: ${name} is gone (${response.status}), removed its subscription`);
      } else {
        this.log(`push: ${name} answered ${response.status} ${reason}`.trimEnd());
      }
      return { ok: false, status: response.status, reason, gone };
    } catch (error) {
      // The error of a failed request can name the address it went to, which is not for the log.
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "The push service did not answer in time"
          : "The push service could not be reached";
      this.log(`push: sending to ${name} failed: ${reason}`);
      return { ok: false, status: null, reason, gone: false };
    }
  }
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
