// Hako's service worker. It does two things: it shows the notifications the relay pushes, and it
// opens the terminal (or the preview) a notification is about when the notification is tapped.
//
// It has no `fetch` handler, on purpose. Nothing is cached and nothing is answered from here:
// every page, script and request goes to the network exactly as it would without this worker, so
// the app is never older than what the server serves.

/** How long a tapped notification's terminal is kept for a page that has not asked yet. */
const PENDING_MAX_AGE_MS = 60_000;

/** The terminal of the last tapped notification, until a page has taken it. */
let pending = null;

// A new version takes over at once, from the pages that are open too.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  try {
    const payload = event.data ? event.data.json() : null;
    if (payload && typeof payload.title === "string" && payload.title !== "") return payload;
  } catch {
    // Not JSON: shown as a notification without details, below.
  }
  return null;
}

function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  // Every push ends in a notification, even one this worker cannot read: an iPhone withdraws the
  // permission from an app that receives pushes without showing anything.
  const title = payload ? payload.title : "Hako";
  const options = {
    body: payload ? (text(payload.body) ?? "") : "Something on your Mac wants your attention.",
    // One tag for each terminal, so a newer notification takes the older one's place.
    tag: (payload && text(payload.tag)) ?? "hako",
    renotify: true,
    icon: "/icon-192.png",
    data: {
      kind: payload ? text(payload.kind) : null,
      session_id: payload ? text(payload.session_id) : null,
      tab_id: payload ? text(payload.tab_id) : null,
      ...(payload && text(payload.preview_id) ? { preview_id: text(payload.preview_id) } : {}),
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

function targetOf(notification) {
  const data = notification.data ?? {};
  const previewId = text(data.preview_id);
  if (previewId !== null && /^[a-z0-9-]{1,40}$/.test(previewId)) return { preview_id: previewId };
  const sessionId = text(data.session_id);
  return sessionId === null ? null : { session_id: sessionId, tab_id: text(data.tab_id) };
}

/**
 * Brings the app to the front at the notification's terminal. An open window is focused and told
 * where to go, which keeps what it has loaded; with none open the app is opened at the terminal's
 * address. The target is also kept for a moment, for a page that comes back from the background
 * without having received the message, or that a phone opened at its start address instead.
 */
async function openApp(target) {
  pending = target === null ? null : { target, at: Date.now() };
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client =
    windows.find((candidate) => candidate.focused) ??
    windows.find((candidate) => candidate.visibilityState === "visible") ??
    windows[0];
  if (client) {
    if (target !== null) client.postMessage({ type: "hako:open", target });
    try {
      await client.focus();
    } catch {
      // Not allowed to focus: the message has still been delivered.
    }
    return;
  }
  const address =
    target === null
      ? "/"
      : target.preview_id
        ? `/#/p/${target.preview_id}`
        : `/#/t/${encodeURIComponent(target.session_id)}`;
  await self.clients.openWindow(address);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp(targetOf(event.notification)));
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "hako:taken") {
    pending = null;
  } else if (type === "hako:pending") {
    const fresh = pending !== null && Date.now() - pending.at < PENDING_MAX_AGE_MS;
    const target = fresh ? pending.target : null;
    pending = null;
    if (target !== null && event.source) event.source.postMessage({ type: "hako:open", target });
  }
});
