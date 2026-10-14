import {
  NOTIFY_COLLAPSE_MS,
  NOTIFY_MAX_PER_MINUTE,
  type NotifyEvent,
  type NotifyKind,
  notifySubject,
  readNotify,
} from "../shared/notify.ts";

export type NotifyGateOptions = {
  /** Called once for every notification that is to go out, to the devices and to the clients. */
  deliver: (notification: NotifyEvent) => void;
  collapseMs?: number;
  maxPerMinute?: number;
  now?: () => number;
  log?: (message: string) => void;
};

type Delivered = { at: number; title: string; body: string };

type SessionState = {
  delivered: Map<NotifyKind, Delivered>;
  /** The newest notification that came too soon after the last one of its kind. */
  held: NotifyEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const MINUTE_MS = 60_000;
/** Above this many remembered sessions, the ones that have been quiet are forgotten. */
const SESSIONS_KEPT = 200;

/**
 * Decides which `notify` events from the agent go out, by the collapse rule of docs/protocol.md:
 * one session and kind is delivered at most once in `collapseMs`, a repeat with the same words is
 * dropped, and one with new words waits for the end of that time, where only the newest is sent.
 */
export class NotifyGate {
  private readonly deliver: (notification: NotifyEvent) => void;
  private readonly collapseMs: number;
  private readonly maxPerMinute: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private recent: number[] = [];

  constructor(options: NotifyGateOptions) {
    this.deliver = options.deliver;
    this.collapseMs = options.collapseMs ?? NOTIFY_COLLAPSE_MS;
    this.maxPerMinute = options.maxPerMinute ?? NOTIFY_MAX_PER_MINUTE;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Takes the data of a `notify` event as the agent sent it. */
  accept(data: unknown): void {
    const notification = readNotify(data);
    if (notification === null) {
      this.log("dropped a notify event that is not one: unknown kind, no session or no title");
      return;
    }
    const subject = notifySubject(notification);
    const state = this.stateOf(subject);
    const last = state.delivered.get(notification.kind);
    const now = this.now();
    if (last === undefined || now - last.at >= this.collapseMs) {
      // Whatever was waiting is older than this one, and says less about the terminal.
      this.forgetHeld(state);
      this.send(state, notification);
      return;
    }
    if (last.title === notification.title && last.body === notification.body) return;
    state.held = notification;
    if (state.timer === null) this.arm(subject, state, last.at + this.collapseMs);
  }

  /** Stops every timer. Notifications that were waiting are not sent. */
  close(): void {
    for (const state of this.sessions.values()) this.forgetHeld(state);
    this.sessions.clear();
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= SESSIONS_KEPT) this.forgetQuietSessions();
      state = { delivered: new Map(), held: null, timer: null };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private forgetQuietSessions(): void {
    const now = this.now();
    for (const [sessionId, state] of this.sessions) {
      if (state.held !== null) continue;
      const quiet = [...state.delivered.values()].every((item) => now - item.at >= this.collapseMs);
      if (quiet) this.sessions.delete(sessionId);
    }
  }

  private forgetHeld(state: SessionState): void {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.held = null;
  }

  private arm(sessionId: string, state: SessionState, due: number): void {
    state.timer = setTimeout(() => this.release(sessionId), Math.max(0, due - this.now()));
    state.timer.unref();
  }

  private release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.timer = null;
    const held = state.held;
    if (held === null) return;
    // The one that waits may have been replaced by one of another kind, which has its own time.
    const last = state.delivered.get(held.kind);
    const due = last ? last.at + this.collapseMs : 0;
    if (this.now() < due) {
      this.arm(sessionId, state, due);
      return;
    }
    state.held = null;
    if (last && last.title === held.title && last.body === held.body) return;
    this.send(state, held);
  }

  private send(state: SessionState, notification: NotifyEvent): void {
    const now = this.now();
    state.delivered.set(notification.kind, {
      at: now,
      title: notification.title,
      body: notification.body,
    });
    this.recent = this.recent.filter((at) => now - at < MINUTE_MS);
    if (this.recent.length >= this.maxPerMinute) {
      this.log(`dropped a ${notification.kind} notification: over ${this.maxPerMinute} a minute`);
      return;
    }
    this.recent.push(now);
    try {
      this.deliver(notification);
    } catch (error) {
      this.log(`notify failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
