// Notifications on this device: whether the browser can show them, the permission, the push
// subscription and its copy on the relay, what the owner wants to hear about, and the banners
// shown inside the app while it is open.

import {
  DEFAULT_NOTIFY_PREFS,
  type DeviceState,
  NOTIFY_KINDS,
  type NotifyEvent,
  type NotifyKind,
  type NotifyPrefs,
  notifyTag,
  readNotify,
} from "@shared/notify";
import { api, type PrefsChange } from "./api";
import { relay } from "./connection";
import { navigate, parseRoute, routes } from "./route";
import { workspaceStore } from "./workspace";

/**
 * What stands between this device and a notification:
 * - `unsupported`: this browser has no web push.
 * - `ios-update`: a home-screen app on an iPhone whose iOS is older than web push.
 * - `needs-home-screen`: an iPhone or iPad showing the app in a browser tab.
 * - `ask`: nobody has been asked yet.
 * - `denied`: the owner, or a setting, said no.
 * - `granted`: allowed; `link` says whether the relay knows this device.
 */
export type Availability =
  "unsupported" | "ios-update" | "needs-home-screen" | "ask" | "denied" | "granted";

export type NotificationsSnapshot = {
  availability: Availability;
  /** Meaningful while `availability` is `granted`. */
  link: "connecting" | "ready" | "failed";
  /** True from the tap on "Turn on" until the permission question has been answered. */
  asking: boolean;
  /** Why the device could not be registered, or a preference not saved. */
  problem: string | null;
  prefs: NotifyPrefs;
  /** True on an iPhone or iPad, where the way to change a permission is the Settings app. */
  ios: boolean;
};

export type TestOutcome = { ok: true } | { ok: false; message: string };

const PREFS_KEY = "hako.notify.prefs";
/** Development only: shows one state of the Notifications screen whatever the browser says. */
const FORCE_KEY = "hako.notify.force";
const FORCED = [
  "unsupported",
  "ios-update",
  "needs-home-screen",
  "ask",
  "denied",
  "denied-ios",
  "connecting",
  "failed",
  "enabled",
  "enabled-test-fails",
] as const;
type Forced = (typeof FORCED)[number];

const OFFLINE = "Can’t reach the server. Check your connection and try again.";

function readForced(): Forced | null {
  if (!import.meta.env.DEV) return null;
  try {
    const value = localStorage.getItem(FORCE_KEY);
    return (FORCED as readonly string[]).includes(value ?? "") ? (value as Forced) : null;
  } catch {
    return null;
  }
}

function readPrefs(): NotifyPrefs {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (typeof stored !== "object" || stored === null) return DEFAULT_NOTIFY_PREFS;
    const { muted, kinds } = stored as { muted?: unknown; kinds?: Record<string, unknown> };
    const read = (kind: NotifyKind) =>
      typeof kinds?.[kind] === "boolean" ? kinds[kind] : DEFAULT_NOTIFY_PREFS.kinds[kind];
    return {
      muted: muted === true,
      kinds: {
        agent_waiting: read("agent_waiting"),
        agent_done: read("agent_done"),
        command_done: read("command_done"),
      },
    };
  } catch {
    return DEFAULT_NOTIFY_PREFS;
  }
}

function writePrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing: the preferences last as long as the page.
  }
}

function samePrefs(a: NotifyPrefs, b: NotifyPrefs): boolean {
  return a.muted === b.muted && NOTIFY_KINDS.every((kind) => a.kinds[kind] === b.kinds[kind]);
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // An iPad says it is a Mac, but a Mac has no touch screen.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isHomeScreenApp(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function detect(forced: Forced | null): Pick<NotificationsSnapshot, "availability" | "ios"> {
  const ios = isIos();
  if (forced !== null) {
    const availability: Availability =
      forced === "connecting" || forced === "failed" || forced.startsWith("enabled")
        ? "granted"
        : forced === "denied-ios"
          ? "denied"
          : (forced as Availability);
    const pretendIos = ["needs-home-screen", "ios-update", "denied-ios"].includes(forced);
    return { availability, ios: ios || pretendIos };
  }
  if (ios && !isHomeScreenApp()) return { availability: "needs-home-screen", ios };
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return { availability: ios ? "ios-update" : "unsupported", ios };
  const permission = Notification.permission;
  return {
    availability: permission === "granted" ? "granted" : permission === "denied" ? "denied" : "ask",
    ios,
  };
}

function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  // A browser that does not tell which key a subscription was made with is taken at its word.
  if (!a) return true;
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((value, index) => value === b[index]);
}

/** The relay's name for an endpoint: the SHA-256 of it, in hex. */
async function endpointId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let forced = readForced();
let snapshot: NotificationsSnapshot = {
  ...detect(forced),
  link: forced === "failed" ? "failed" : forced?.startsWith("enabled") ? "ready" : "connecting",
  asking: false,
  problem: forced === "failed" ? OFFLINE : null,
  prefs: readPrefs(),
};
const listeners = new Set<() => void>();
let registration: Promise<ServiceWorkerRegistration> | null = null;
let started = false;
let syncing: Promise<void> | null = null;

function set(change: Partial<NotificationsSnapshot>): void {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}

/**
 * Registers the service worker. It caches nothing; it is there for notifications, and registering
 * it before anyone has asked for them costs nothing and lets a tapped notification find the app.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || registration) return;
  registration = navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  registration.catch(() => {
    registration = null;
  });
  navigator.serviceWorker.addEventListener("message", onWorkerMessage);
  navigator.serviceWorker.startMessages();
  askWorkerForTarget();
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  if (!registration) registerServiceWorker();
  if (!registration) throw new Error("no service worker");
  await registration;
  return navigator.serviceWorker.ready;
}

function adopt(device: DeviceState): void {
  if (!device.subscribed) return;
  const prefs = { muted: device.muted, kinds: device.kinds };
  if (samePrefs(prefs, snapshot.prefs)) return;
  writePrefs(prefs);
  set({ prefs });
}

/**
 * Makes the relay's copy of this device match the browser: subscribes when the browser has no
 * subscription (or one made for another relay key), and stores it when the relay has none, or
 * another. It asks the owner nothing, so it runs whenever the app opens.
 */
function sync(): Promise<void> {
  syncing ??= (async () => {
    if (snapshot.link !== "ready") set({ link: "connecting", problem: null });
    try {
      const worker = await activeRegistration();
      const key = await api.pushKey();
      if (!key.ok) throw new Error(key.error.kind);
      const serverKey = decodeKey(key.value.key);
      let subscription = await worker.pushManager.getSubscription();
      if (subscription && !sameBytes(subscription.options.applicationServerKey, serverKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });
      const [device, id] = await Promise.all([api.pushDevice(), endpointId(subscription.endpoint)]);
      if (!device.ok) throw new Error(device.error.kind);
      if (device.value.subscribed && device.value.endpoint_id === id) {
        adopt(device.value);
      } else {
        const saved = await api.pushSubscribe(subscription.toJSON(), snapshot.prefs);
        if (!saved.ok) throw new Error(saved.error.kind);
      }
      set({ link: "ready", problem: null });
    } catch (error) {
      const offline = error instanceof Error && error.message === "network";
      set({
        link: "failed",
        problem: offline
          ? OFFLINE
          : "This device couldn’t be registered for notifications. Try again in a moment.",
      });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Reads the permission again, and registers the device when it is allowed and signed in. */
function refresh(): void {
  if (forced !== null) return;
  const next = detect(null);
  if (next.availability !== snapshot.availability) set(next);
  if (started && next.availability === "granted") void sync();
}

function onVisible(): void {
  if (document.visibilityState !== "visible") return;
  // The owner may be coming back from the Settings app with the permission changed.
  refresh();
  askWorkerForTarget();
}

async function saveChange(change: PrefsChange, previous: NotifyPrefs): Promise<void> {
  if (forced !== null || snapshot.availability !== "granted" || snapshot.link !== "ready") return;
  const saved = await api.pushSettings(change);
  if (saved.ok) {
    set({ problem: null });
    return;
  }
  if (saved.error.kind === "server" && saved.error.code === "not_subscribed") {
    // The relay lost this device; registering it again carries the preferences along.
    void sync();
    return;
  }
  writePrefs(previous);
  set({
    prefs: previous,
    problem:
      saved.error.kind === "network" ? OFFLINE : "That couldn’t be saved. Try again in a moment.",
  });
}

function change(next: NotifyPrefs, sent: PrefsChange): void {
  const previous = snapshot.prefs;
  writePrefs(next);
  set({ prefs: next });
  void saveChange(sent, previous);
}

async function runTest(retried = false): Promise<TestOutcome> {
  const result = await api.pushTest();
  if (result.ok) return { ok: true };
  const error = result.error;
  if (error.kind === "network") return { ok: false, message: OFFLINE };
  if (error.kind === "server" && (error.status === 410 || error.status === 404) && !retried) {
    // The push service, or the relay, no longer knew this device: register it again and retry.
    await sync();
    if (snapshot.link === "ready") return runTest(true);
  }
  if (error.kind === "server" && error.code === "push_failed") {
    return {
      ok: false,
      message: `The push service didn’t take it${error.reason ? ` (${error.reason})` : ""}. Try again in a moment.`,
    };
  }
  return { ok: false, message: "The test couldn’t be sent. Try again in a moment." };
}

export const notifications = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): NotificationsSnapshot => snapshot,

  /** Call when the owner is signed in: registers this device if notifications are allowed. */
  start(): void {
    if (started) return;
    started = true;
    forced = readForced();
    document.addEventListener("visibilitychange", onVisible);
    refresh();
  },

  /** Call when the owner is signed out. */
  stop(): void {
    started = false;
    document.removeEventListener("visibilitychange", onVisible);
    arrivals.clear();
    banners.clear();
    if (forced === null) set({ link: "connecting", problem: null, asking: false });
  },

  /**
   * Asks for the permission. Call it straight from the tap on a button: a browser only shows the
   * question in answer to one, so nothing may be awaited first.
   */
  enable(): void {
    if (forced !== null || snapshot.availability !== "ask" || snapshot.asking) return;
    const asked = new Promise<void>((resolve) => {
      // Older browsers take a callback and return nothing.
      const result = Notification.requestPermission(() => resolve()) as Promise<unknown> | void;
      if (result)
        result.then(
          () => resolve(),
          () => resolve(),
        );
    });
    set({ asking: true });
    void asked.then(() => {
      set({ asking: false });
      refresh();
    });
  },

  retry(): void {
    if (forced === null) void sync();
  },

  setMuted(muted: boolean): void {
    change({ ...snapshot.prefs, muted }, { muted });
  },

  setKind(kind: NotifyKind, on: boolean): void {
    change(
      { ...snapshot.prefs, kinds: { ...snapshot.prefs.kinds, [kind]: on } },
      { kinds: { [kind]: on } },
    );
  },

  async sendTest(): Promise<TestOutcome> {
    if (forced !== null) {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      return forced === "enabled-test-fails"
        ? {
            ok: false,
            message: "The push service didn’t take it (403 BadJwtToken). Try again in a moment.",
          }
        : { ok: true };
    }
    return runTest();
  },

  /**
   * Takes this device off the relay and ends its push subscription, for logging out. It gives up
   * after a few seconds, since the relay forgets the device with the session anyway.
   */
  async forget(): Promise<void> {
    if (forced !== null || snapshot.availability !== "granted") return;
    const work = (async () => {
      await api.pushUnsubscribe();
      const worker = await activeRegistration();
      await (await worker.pushManager.getSubscription())?.unsubscribe();
    })().catch(() => {});
    await Promise.race([work, new Promise((resolve) => window.setTimeout(resolve, 3_000))]);
  },

  /** Takes away the notification of a terminal the owner is now looking at. */
  async clearFor(sessionId: string): Promise<void> {
    if (snapshot.availability !== "granted" || !registration) return;
    try {
      const worker = await registration;
      const shown = await worker.getNotifications({ tag: notifyTag(sessionId) });
      for (const notification of shown) notification.close();
    } catch {
      // Not every browser lists its notifications.
    }
  },
};

// A tapped notification

export type Arrival = { sessionId: string; tabId: string | null; at: number };

let arrival: Arrival | null = null;
const arrivalListeners = new Set<() => void>();

/**
 * The terminal a tapped notification asked for, kept until the workspace has been read again and
 * says whether that terminal still exists.
 */
export const arrivals = {
  subscribe(listener: () => void): () => void {
    arrivalListeners.add(listener);
    return () => arrivalListeners.delete(listener);
  },
  getSnapshot: (): Arrival | null => arrival,
  clear(): void {
    if (arrival === null) return;
    arrival = null;
    for (const listener of arrivalListeners) listener();
  },
};

function openFromNotification(target: { session_id?: unknown; tab_id?: unknown }): void {
  if (typeof target.session_id !== "string" || target.session_id === "") return;
  arrival = {
    sessionId: target.session_id,
    tabId: typeof target.tab_id === "string" ? target.tab_id : null,
    at: Date.now(),
  };
  for (const listener of arrivalListeners) listener();
  banners.dismissSession(arrival.sessionId);
  navigate(routes.terminal(arrival.sessionId));
  void workspaceStore.refresh();
}

function onWorkerMessage(event: MessageEvent): void {
  const data = event.data as { type?: unknown; target?: unknown } | null;
  if (data?.type !== "hako:open" || typeof data.target !== "object" || data.target === null) return;
  (event.source as ServiceWorker | null)?.postMessage({ type: "hako:taken" });
  openFromNotification(data.target);
}

/** Asks the worker whether a notification was tapped that this page has not heard of. */
function askWorkerForTarget(): void {
  if (!registration) return;
  void registration
    .then(() => navigator.serviceWorker.ready)
    .then((worker) => worker.active?.postMessage({ type: "hako:pending" }))
    .catch(() => {});
}

// Banners inside the app

export type Banner = { id: number; notification: NotifyEvent };

const BANNER_MS = 10_000;
const BANNERS_SHOWN = 3;

let shownBanners: Banner[] = [];
let nextBannerId = 1;
const bannerListeners = new Set<() => void>();
const bannerTimers = new Map<number, number>();

function setBanners(next: Banner[]): void {
  shownBanners = next;
  for (const [id, timer] of bannerTimers) {
    if (next.some((banner) => banner.id === id)) continue;
    window.clearTimeout(timer);
    bannerTimers.delete(id);
  }
  for (const listener of bannerListeners) listener();
}

export const banners = {
  subscribe(listener: () => void): () => void {
    bannerListeners.add(listener);
    return () => bannerListeners.delete(listener);
  },
  getSnapshot: (): Banner[] => shownBanners,
  dismiss(id: number): void {
    setBanners(shownBanners.filter((banner) => banner.id !== id));
  },
  /** Keeps a banner for as long as the pointer or the keyboard's focus is on it. */
  hold(id: number): void {
    window.clearTimeout(bannerTimers.get(id));
    bannerTimers.delete(id);
  },
  release(id: number): void {
    if (bannerTimers.has(id) || !shownBanners.some((banner) => banner.id === id)) return;
    bannerTimers.set(
      id,
      window.setTimeout(() => banners.dismiss(id), BANNER_MS),
    );
  },
  dismissSession(sessionId: string): void {
    setBanners(shownBanners.filter((banner) => banner.notification.session_id !== sessionId));
  },
  clear(): void {
    setBanners([]);
  },
};

relay.on("notify", (data) => {
  const notification = readNotify(data);
  if (notification === null) return;
  // The list shows the same agent's status; read it again so the two never disagree.
  void workspaceStore.refresh();
  const { prefs } = snapshot;
  if (prefs.muted || !prefs.kinds[notification.kind]) return;
  // Out of sight, the system's notification speaks; a banner nobody sees would only be stale.
  if (document.visibilityState !== "visible") return;
  const route = parseRoute(window.location.hash);
  if (route.name === "terminal" && route.sessionId === notification.session_id) return;
  const banner = { id: nextBannerId++, notification };
  // As on the device, a terminal has one notification: the newest.
  const others = shownBanners.filter(
    (shown) => shown.notification.session_id !== notification.session_id,
  );
  setBanners([banner, ...others].slice(0, BANNERS_SHOWN));
  banners.release(banner.id);
});
