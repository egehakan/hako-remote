// The client's one WebSocket to the relay: requests, events, terminal output, and staying connected.

import { decodeOutputFrame, type OutputFrame } from "@shared/frames";
import {
  type AgentStatus,
  CLOSE_SESSION_ENDED,
  type ErrorCode,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
} from "@shared/protocol";

export type LinkState = "idle" | "connecting" | "open" | "retrying";

export type ConnectionSnapshot = {
  link: LinkState;
  /** Null until the relay has said whether the Mac is connected. */
  agent: AgentStatus | null;
};

export class RpcFailure extends Error {
  readonly code: ErrorCode | "disconnected";

  constructor(code: ErrorCode | "disconnected", message: string) {
    super(message);
    this.code = code;
  }
}

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: RpcFailure) => void };
type EventHandler = (data: unknown) => void;
type OutputHandler = (frame: OutputFrame) => void;

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8_000;
/** How long a connection gets to prove it is alive after the page comes back to the foreground. */
const WAKE_CHECK_MS = 4_000;

class RelayConnection {
  private socket: WebSocket | null = null;
  private snapshot: ConnectionSnapshot = { link: "idle", agent: null };
  private wanted = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private wakeTimer: number | undefined;
  private lastFrameAt = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<() => void>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly outputHandlers = new Map<string, Set<OutputHandler>>();

  /** Called when the relay says the login session is no longer valid. */
  onUnauthorized: () => void = () => {};

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ConnectionSnapshot => this.snapshot;

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("online", this.connectNow);
    window.addEventListener("pageshow", this.onVisibilityChange);
    this.open();
  }

  stop(): void {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("online", this.connectNow);
    window.removeEventListener("pageshow", this.onVisibilityChange);
    window.clearTimeout(this.retryTimer);
    this.dropSocket();
    this.set({ link: "idle", agent: null });
  }

  request<T>(method: string, params: object = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RpcFailure("disconnected", "Not connected to the relay"));
    }
    const id = String(this.nextRequestId++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }

  notify(method: string, params: object = {}): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: "ntf", method, params }));
    }
  }

  on(event: string, handler: EventHandler): () => void {
    return addTo(this.eventHandlers, event, handler);
  }

  /** Receives the binary output frames of one terminal session. Subscribing is a separate request. */
  onOutput(sessionId: string, handler: OutputHandler): () => void {
    return addTo(this.outputHandlers, sessionId, handler);
  }

  private open(): void {
    window.clearTimeout(this.retryTimer);
    if (!this.wanted || this.socket) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws/client`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    this.set({ link: this.snapshot.link === "idle" ? "connecting" : this.snapshot.link });

    socket.onopen = () => {
      opened = true;
      this.retryMs = RETRY_MIN_MS;
      this.lastFrameAt = Date.now();
      this.pingTimer = window.setInterval(this.heartbeat, PING_INTERVAL_MS);
      this.set({ link: "open" });
    };
    socket.onmessage = (message) => {
      this.lastFrameAt = Date.now();
      window.clearTimeout(this.wakeTimer);
      if (typeof message.data === "string") this.handleText(message.data);
      else this.handleBinary(new Uint8Array(message.data as ArrayBuffer));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.dropSocket();
      if (!this.wanted) return;
      if (event.code === CLOSE_SESSION_ENDED) {
        this.onUnauthorized();
        return;
      }
      this.set({ link: "retrying", agent: null });
      // A refused upgrade looks like any other failed connection, so ask whether we are logged in.
      if (!opened) void this.checkSession();
      this.retryTimer = window.setTimeout(
        () => this.open(),
        this.retryMs * (0.75 + Math.random() / 2),
      );
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  private async checkSession(): Promise<void> {
    try {
      const response = await fetch("/api/me", { credentials: "same-origin" });
      if (response.status === 401 && this.wanted) this.onUnauthorized();
    } catch {
      // Offline: the retry loop keeps going.
    }
  }

  private dropSocket(): void {
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.wakeTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
    for (const request of this.pending.values()) {
      request.reject(new RpcFailure("disconnected", "The connection to the relay was lost"));
    }
    this.pending.clear();
  }

  private reconnect(): void {
    this.dropSocket();
    this.set({ link: "retrying", agent: null });
    this.open();
  }

  private readonly heartbeat = (): void => {
    if (Date.now() - this.lastFrameAt > IDLE_TIMEOUT_MS) this.reconnect();
    else this.socket?.send('{"t":"ping"}');
  };

  private readonly connectNow = (): void => {
    if (!this.wanted || this.socket) return;
    this.retryMs = RETRY_MIN_MS;
    this.open();
  };

  /** A phone suspends sockets in the background, so a returning page checks before trusting one. */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" || !this.wanted) return;
    const socket = this.socket;
    if (!socket) {
      this.connectNow();
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.send('{"t":"ping"}');
      window.clearTimeout(this.wakeTimer);
      this.wakeTimer = window.setTimeout(() => this.reconnect(), WAKE_CHECK_MS);
    }
  };

  private handleText(text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.t === "res" && typeof frame.id === "string") {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      if (frame.ok === true) {
        request.resolve(frame.result);
      } else {
        const error = (frame.error ?? {}) as { code?: ErrorCode; message?: string };
        request.reject(new RpcFailure(error.code ?? "failed", error.message ?? "Request failed"));
      }
    } else if (frame.t === "evt" && typeof frame.event === "string") {
      if (frame.event === "agent.status") {
        this.set({ agent: frame.data as AgentStatus });
      }
      for (const handler of this.eventHandlers.get(frame.event) ?? []) handler(frame.data);
    }
  }

  private handleBinary(bytes: Uint8Array): void {
    const frame = decodeOutputFrame(bytes);
    if (!frame) return;
    for (const handler of this.outputHandlers.get(frame.sessionId) ?? []) handler(frame);
  }

  private set(change: Partial<ConnectionSnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if (next.link === this.snapshot.link && next.agent === this.snapshot.agent) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function addTo<T>(map: Map<string, Set<T>>, key: string, handler: T): () => void {
  let handlers = map.get(key);
  if (!handlers) {
    handlers = new Set();
    map.set(key, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) map.delete(key);
  };
}

export const relay = new RelayConnection();
