// The `notify` event of docs/protocol.md ("Notifications"): its shape, its limits and how a relay
// cleans one. Shared by the relay, the web client, the service worker's payload and the mock agent.

export const NOTIFY_KINDS = ["agent_waiting", "agent_done", "command_done"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyEvent = {
  kind: NotifyKind;
  title: string;
  body: string;
  session_id: string;
  tab_id: string | null;
};

/** Which kinds a device wants, and whether it wants any at all. */
export type NotifyPrefs = { muted: boolean; kinds: Record<NotifyKind, boolean> };

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  muted: false,
  kinds: { agent_waiting: true, agent_done: true, command_done: true },
};

/** What the relay holds for the device a login session belongs to (`GET /api/push/device`). */
export type DeviceState =
  { subscribed: false } | ({ subscribed: true; endpoint_id: string } & NotifyPrefs);

/** Limits in Unicode code points (what Rust's `chars()` counts). */
export const NOTIFY_TITLE_MAX = 100;
export const NOTIFY_BODY_MAX = 300;
/** Limit of an id in UTF-8 bytes, the same as a session id has in a terminal output frame. */
export const NOTIFY_ID_MAX_BYTES = 255;

/** How long one session and kind stay quiet after a notification of theirs went out. */
export const NOTIFY_COLLAPSE_MS = 5_000;
/** How many notifications go out in any 60 seconds, over all sessions. */
export const NOTIFY_MAX_PER_MINUTE = 20;

/** What a push message carries to the service worker, as JSON. */
export type PushPayload = {
  v: 1;
  kind: NotifyKind | "test";
  title: string;
  body: string;
  session_id: string | null;
  tab_id: string | null;
  tag: string;
};

export function isNotifyKind(value: unknown): value is NotifyKind {
  return (NOTIFY_KINDS as readonly unknown[]).includes(value);
}

/** One tag per terminal, so a newer notification replaces the older one on the device. */
export function notifyTag(sessionId: string): string {
  return `hako:${sessionId}`;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

// C0 and C1 control characters, the line and paragraph separators, and the characters that only
// change the direction or the shape of text around them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** One line of plain text: control characters become spaces, runs of white space become one. */
function cleanLine(value: string, max: number): string {
  return truncate(value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim(), max);
}

/** Plain text that keeps its line breaks, with at most one blank line in a row. */
function cleanText(value: string, max: number): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(CONTROL, " ").replace(/\s+/gu, " ").trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  return truncate(kept.join("\n"), max);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return byteLength(value) <= NOTIFY_ID_MAX_BYTES ? value : null;
}

/**
 * Reads the data of a `notify` event. Returns the notification with its text cleaned and cut to
 * the limits, or null when it is not one the relay delivers: an unknown kind, no usable
 * `session_id`, or no title left once cleaned.
 */
export function readNotify(data: unknown): NotifyEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (!isNotifyKind(record.kind)) return null;
  const sessionId = cleanId(record.session_id);
  if (sessionId === null) return null;
  if (typeof record.title !== "string") return null;
  const title = cleanLine(record.title, NOTIFY_TITLE_MAX);
  if (title === "") return null;
  const body = typeof record.body === "string" ? cleanText(record.body, NOTIFY_BODY_MAX) : "";
  return { kind: record.kind, title, body, session_id: sessionId, tab_id: cleanId(record.tab_id) };
}
