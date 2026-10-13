// One terminal session as the protocol describes it: subscribe, take the snapshot, apply output in
// order, and start over from a new snapshot whenever something may have been missed.

import type { OutputFrame } from "@shared/frames";
import type { TermSubscribeResult } from "@shared/protocol";
import { capFit } from "./fit";
import { RpcFailure, relay } from "../connection";
import { SeqTracker } from "./seq";

export type TerminalSink = {
  /** Clears the terminal and draws a snapshot taken at `cols` x `rows`. */
  replace(cols: number, rows: number, bytes: Uint8Array): void;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
};

export type SessionPhase =
  /** Nothing on screen yet. */
  | "waiting"
  | "live"
  /** The last screen is still shown, but nothing reaches the Mac. */
  | "frozen"
  /** The session ended on the Mac. */
  | "closed"
  /** The Mac knows no such session. */
  | "missing"
  /** The Hako on the Mac is too old to stream terminals. */
  | "unsupported";

export type SessionState = {
  phase: SessionPhase;
  /** Why nothing is live: the relay cannot be reached, or the Mac is not connected to it. */
  reason: "relay" | "mac" | null;
  cols: number;
  rows: number;
  /** Set when the Mac refused to resize the terminal for this screen. */
  fitError: string | null;
};

export type Size = { cols: number; rows: number };

const RETRY_MS = 2_000;
const MAX_HELD_FRAMES = 4_000;

/** How many live objects hold each session, so one that leaves late does not cut off its successor. */
const holders = new Map<string, number>();

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isUp(): boolean {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
}

export class TerminalSession {
  readonly sessionId: string;
  private readonly sink: TerminalSink;
  private state: SessionState = {
    phase: "waiting",
    reason: null,
    cols: 0,
    rows: 0,
    fitError: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly tracker = new SeqTracker();
  private readonly cleanups: (() => void)[] = [];
  private inFlight: Promise<void> | null = null;
  /** Output that arrived while a snapshot was on its way; most of it is older than the snapshot. */
  private held: OutputFrame[] = [];
  private retryTimer: number | undefined;
  private started = false;
  private stopped = false;
  private wasUp = false;
  /** The size this screen wants the terminal to have, or null to leave it to the Mac. */
  private fit: Size | null = null;
  /** The size the Mac was last asked for and has not been told to forget. */
  private fitSent: Size | null = null;
  /** The size the terminal has on the Mac by itself: the last one reported while none was asked for. */
  private macSize: Size | null = null;

  constructor(sessionId: string, sink: TerminalSink) {
    this.sessionId = sessionId;
    this.sink = sink;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState => this.state;

  start(): void {
    if (this.started) return;
    this.started = true;
    holders.set(this.sessionId, (holders.get(this.sessionId) ?? 0) + 1);
    this.cleanups.push(
      relay.onOutput(this.sessionId, this.onFrame),
      relay.on("term.size", this.onSize),
      relay.on("term.closed", this.onClosed),
      relay.subscribe(this.onLink),
    );
    document.addEventListener("visibilitychange", this.onVisible);
    this.onLink();
  }

  /** Leaves the session: gives the size back if this screen took it, and stops the stream. */
  stop(): void {
    if (this.stopped || !this.started) return;
    this.stopped = true;
    for (const cleanup of this.cleanups) cleanup();
    document.removeEventListener("visibilitychange", this.onVisible);
    window.clearTimeout(this.retryTimer);
    const left = (holders.get(this.sessionId) ?? 1) - 1;
    if (left > 0) holders.set(this.sessionId, left);
    else holders.delete(this.sessionId);

    if (this.fitSent && isUp()) {
      void relay.request("term.release_size", { session_id: this.sessionId }).catch(() => {});
    }
    // A subscription the Mac has not confirmed yet cannot be cancelled, so wait for its answer.
    const leave = () => {
      if (holders.has(this.sessionId) || !isUp()) return;
      void relay.request("term.unsubscribe", { session_id: this.sessionId }).catch(() => {});
    };
    if (this.inFlight) void this.inFlight.then(leave);
    else leave();
  }

  /** True when typed input reaches the Mac right now. */
  get live(): boolean {
    return this.state.phase === "live";
  }

  send(data: string): void {
    if (data === "" || !this.live) return;
    relay.notify("term.input", { session_id: this.sessionId, data });
  }

  /** Asks the Mac to resize the terminal to this screen, or with null to take its own size back. */
  setFit(size: Size | null): void {
    this.fit = size;
    if (size === null && this.state.fitError !== null) this.set({ fitError: null });
    this.syncFit();
  }

  /** Throws away the screen and asks for a new snapshot. */
  refresh(): void {
    if (this.stopped || !isUp()) return;
    window.clearTimeout(this.retryTimer);
    if (this.inFlight) return;
    this.inFlight = this.takeSnapshot().finally(() => {
      this.inFlight = null;
    });
  }

  private async takeSnapshot(): Promise<void> {
    for (;;) {
      this.tracker.clear();
      this.held = [];
      let result: TermSubscribeResult;
      try {
        result = await relay.request<TermSubscribeResult>("term.subscribe", {
          session_id: this.sessionId,
        });
      } catch (error) {
        this.held = [];
        if (this.stopped || !isUp()) return;
        const code = error instanceof RpcFailure ? error.code : "failed";
        if (code === "not_found") this.set({ phase: "missing", reason: null });
        else if (code === "not_supported") this.set({ phase: "unsupported", reason: null });
        else this.retryTimer = window.setTimeout(() => this.refresh(), RETRY_MS);
        return;
      }
      if (this.stopped) return;

      this.sink.replace(result.cols, result.rows, decodeBase64(result.snapshot));
      this.tracker.reset(result.seq);
      const held = this.held;
      this.held = [];
      let gap = held.length > MAX_HELD_FRAMES;
      for (const frame of held) {
        if (gap) break;
        gap = !this.apply(frame);
      }
      this.noteMacSize(result.cols, result.rows);
      this.set({ phase: "live", reason: null, cols: result.cols, rows: result.rows });
      if (!gap) {
        this.syncFit();
        return;
      }
    }
  }

  /** Writes a frame if it continues the stream. Returns false when bytes are missing before it. */
  private apply(frame: OutputFrame): boolean {
    const verdict = this.tracker.accept(frame.seq, frame.payload.length);
    if (verdict.kind === "gap") return false;
    if (verdict.kind === "apply") this.sink.write(frame.payload.subarray(verdict.offset));
    return true;
  }

  private readonly onFrame = (frame: OutputFrame): void => {
    if (this.inFlight) {
      if (this.held.length <= MAX_HELD_FRAMES) this.held.push(frame);
      return;
    }
    if (!this.apply(frame)) this.refresh();
  };

  private readonly onSize = (data: unknown): void => {
    const size = data as { session_id?: string; cols?: number; rows?: number };
    if (size.session_id !== this.sessionId) return;
    if (typeof size.cols !== "number" || typeof size.rows !== "number") return;
    this.noteMacSize(size.cols, size.rows);
    this.sink.resize(size.cols, size.rows);
    this.set({ cols: size.cols, rows: size.rows });
  };

  /** A size reported while this screen asked for none is the Mac's own, and the most to ask for. */
  private noteMacSize(cols: number, rows: number): void {
    if (this.fitSent === null) this.macSize = { cols, rows };
  }

  private readonly onClosed = (data: unknown): void => {
    if ((data as { session_id?: string }).session_id !== this.sessionId) return;
    this.tracker.clear();
    this.fitSent = null;
    window.clearTimeout(this.retryTimer);
    this.set({ phase: "closed", reason: null });
  };

  private readonly onLink = (): void => {
    if (isUp()) {
      if (this.wasUp) return;
      this.wasUp = true;
      // A session the Mac did not know may exist once a newer Hako connects; an ended one stays so.
      if (this.state.phase !== "closed") this.refresh();
      return;
    }
    this.wasUp = false;
    // The relay forgets subscriptions when the Mac drops, and the Mac its borrowed size.
    this.tracker.clear();
    this.fitSent = null;
    window.clearTimeout(this.retryTimer);
    if (this.state.phase === "closed" || this.state.phase === "missing") return;
    const { link, agent } = relay.getSnapshot();
    const reason = link === "open" && agent !== null ? "mac" : "relay";
    const hadScreen = this.state.phase === "live" || this.state.phase === "frozen";
    this.set({ phase: hadScreen ? "frozen" : "waiting", reason });
  };

  private readonly onVisible = (): void => {
    // A phone suspends the page in the background and output is lost meanwhile without a trace.
    if (document.visibilityState === "visible" && this.live) this.refresh();
  };

  private syncFit(): void {
    if (!this.live) return;
    const wanted = this.fit === null ? null : capFit(this.fit, this.macSize);
    if (wanted === null) {
      if (this.fitSent === null) return;
      this.fitSent = null;
      void relay.request("term.release_size", { session_id: this.sessionId }).catch(() => {});
      return;
    }
    if (this.fitSent?.cols === wanted.cols && this.fitSent.rows === wanted.rows) return;
    this.fitSent = wanted;
    relay
      .request<Size>("term.resize", { session_id: this.sessionId, ...wanted })
      .then((actual) => {
        if (this.stopped || this.fitSent !== wanted) return;
        if (typeof actual?.cols === "number" && typeof actual.rows === "number") {
          this.sink.resize(actual.cols, actual.rows);
          this.set({ cols: actual.cols, rows: actual.rows, fitError: null });
        }
      })
      .catch((error: unknown) => {
        if (this.stopped || this.fitSent !== wanted) return;
        this.fitSent = null;
        if (!isUp()) return;
        const unsupported = error instanceof RpcFailure && error.code === "not_supported";
        this.set({
          fitError: unsupported
            ? "The Hako on your Mac can’t resize terminals yet."
            : "Your Mac didn’t resize the terminal.",
        });
      });
  }

  private set(change: Partial<SessionState>): void {
    const next = { ...this.state, ...change };
    const same = (Object.keys(next) as (keyof SessionState)[]).every(
      (key) => next[key] === this.state[key],
    );
    if (same) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
