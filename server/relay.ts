import { BROWSER_FRAME_TYPE, bidOf, readBrowserFrameBid } from "../shared/browser.ts";
import { readOutputFrameSessionId } from "../shared/frames.ts";
import { isPreviewId, isPort, type Preview } from "../shared/previews.ts";
import { StreamHub, type TunnelStream } from "./previews/streams.ts";
import {
  type AgentStatus,
  CLOSE_REPLACED,
  CLOSE_SESSION_ENDED,
  type ErrorCode,
  type EventFrame,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
  REQUEST_TIMEOUT_MS,
  type ResponseFrame,
} from "../shared/protocol.ts";

/** The part of a WebSocket the relay needs, so the routing can be tested without a network. */
export type RelaySocket = {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  /** Bytes queued and not yet written to the network. */
  bufferedAmount?: () => number;
};

/** What the relay knows about a preview the browser asked for. */
export type PreviewLookup =
  { state: "offline" } | { state: "unknown" } | { state: "found"; preview: Preview };

export type RelayOptions = {
  requestTimeoutMs?: number;
  /** How long to wait for the agent's `app.info` before announcing it without a name. */
  infoTimeoutMs?: number;
  /**
   * Takes the data of every `notify` event in place of the fan-out to clients, so that whoever
   * decides which notifications go out also decides which ones clients see (`sendEvent`).
   */
  onNotify?: (data: unknown) => void;
  log?: (message: string) => void;
  /** How long a byte stream may stay quiet before it is closed (WebSockets excepted). */
  streamIdleMs?: number;
};

type Client = {
  id: string;
  socket: RelaySocket;
  sessionHash: string;
  /** Rewritten ids of this client's requests that the agent has not answered yet. */
  pending: Set<string>;
  /** Terminal sessions this client receives output for. */
  terminals: Set<string>;
  /** Mac browser sessions this client opened, which end when it leaves. */
  browsers: Set<number>;
};

type Pending = {
  client: Client;
  clientRequestId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set for `term.subscribe`: the session to start delivering once the agent says yes. */
  subscribeTo: string | null;
  /** True for `browser.open`: the session in the answer belongs to this client. */
  opensBrowser: boolean;
};

type Agent = {
  socket: RelaySocket;
  info: Omit<AgentStatus, "online"> | null;
  announced: boolean;
  infoRequestId: string;
  infoTimer: ReturnType<typeof setTimeout>;
};

const RELAY_PREFIX = "relay";
/** How long the relay waits for the agent's answer to a request of its own (`preview.list`). */
const OWN_REQUEST_TIMEOUT_MS = 5_000;
/** A preview that is not in the list is asked about again at most this often. */
const PREVIEW_REFRESH_MIN_MS = 2_000;
const PREVIEWS_CHANGED_DELAY_MS = 100;
const MAX_REQUEST_ID_LENGTH = 128;
const INFO_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sessionIdOf(params: unknown): string | null {
  if (!isRecord(params)) return null;
  return typeof params.session_id === "string" && params.session_id.length > 0
    ? params.session_id
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;
}

/**
 * How long one request waits for its answer: what the client asked for, kept within the limits, or
 * the default when it asked for nothing a relay can use.
 */
export function requestTimeout(asked: unknown, fallback: number): number {
  if (typeof asked !== "number" || !Number.isFinite(asked)) return fallback;
  return Math.min(Math.max(Math.floor(asked), REQUEST_TIMEOUT_MIN_MS), REQUEST_TIMEOUT_MAX_MS);
}

/** Rewrites a client's request id so ids from different connections cannot collide at the agent. */
export function rewriteRequestId(connectionId: string, clientRequestId: string): string {
  return `${connectionId}:${clientRequestId}`;
}

/**
 * Passes frames between the one agent and any number of clients. Apart from the terminal
 * subscription methods and the opening and closing of Mac browser sessions, which it has to track
 * to route their output, it forwards method names and payloads without reading them. How long it
 * waits for an answer is the client's to say, request by request, never the method's.
 */
export class Relay {
  private readonly requestTimeoutMs: number;
  private readonly infoTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly onNotify: ((data: unknown) => void) | null;
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Map<string, Set<Client>>();
  /** The client each Mac browser session belongs to, by bid: the one whose `browser.open` made it. */
  private readonly browserOwners = new Map<number, Client>();
  /** Sessions the agent was already told to close because nobody owns them. */
  private readonly orphanBrowsers = new Set<number>();
  /** Sessions the agent was already told to stop streaming because nobody is subscribed. */
  private readonly orphansReported = new Set<string>();
  private agent: Agent | null = null;
  private nextClientNumber = 1;
  private nextRelayRequestNumber = 1;
  /** The relay's own requests to the agent that wait for an answer, by id. */
  private readonly ownRequests = new Map<
    string,
    {
      resolve: (frame: Record<string, unknown> | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** The agent's previews, as `preview.list` last answered; null before it has. */
  private previews: Map<string, Preview> | null = null;
  private previewsLoadedAt = 0;
  private previewsLoading: Promise<void> | null = null;
  private previewsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The byte streams to the agent's previews. */
  readonly streams: StreamHub;

  constructor(options: RelayOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.infoTimeoutMs = options.infoTimeoutMs ?? INFO_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.onNotify = options.onNotify ?? null;
    this.streams = new StreamHub({
      transport: () => {
        const socket = this.agent?.socket;
        if (!socket) return null;
        return {
          send: (data) => socket.send(data),
          bufferedAmount: () => socket.bufferedAmount?.() ?? 0,
        };
      },
      idleMs: options.streamIdleMs,
      log: this.log,
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  status(): AgentStatus {
    const agent = this.agent;
    if (!agent?.announced) return { online: false };
    return { online: true, ...agent.info };
  }

  // Agent side

  attachAgent(socket: RelaySocket): void {
    const previous = this.agent;
    if (previous) {
      this.log("agent replaced by a new connection");
      this.dropAgent(previous);
      previous.socket.close(CLOSE_REPLACED, "replaced");
    }
    const infoRequestId = this.nextRelayRequestId();
    const agent: Agent = {
      socket,
      info: null,
      announced: false,
      infoRequestId,
      infoTimer: setTimeout(() => this.announce(agent), this.infoTimeoutMs),
    };
    agent.infoTimer.unref();
    this.agent = agent;
    this.log("agent connected");
    this.sendTo(socket, { t: "req", id: infoRequestId, method: "app.info", params: {} });
  }

  detachAgent(socket: RelaySocket): void {
    const agent = this.agent;
    if (!agent || agent.socket !== socket) return;
    this.log("agent disconnected");
    this.dropAgent(agent);
  }

  handleAgentMessage(socket: RelaySocket, data: string | Uint8Array): void {
    const agent = this.agent;
    if (!agent || agent.socket !== socket) return;
    if (typeof data !== "string") {
      if (this.streams.handleBinary(data)) return;
      if (data[0] === BROWSER_FRAME_TYPE) this.routeBrowserFrame(agent, data);
      else this.routeOutput(agent, data);
      return;
    }
    const frame = parseFrame(data);
    if (!frame) return;
    if (this.streams.handleText(frame)) return;
    switch (frame.t) {
      case "res":
        this.handleAgentResponse(agent, frame);
        break;
      case "evt":
        this.handleAgentEvent(frame);
        break;
      case "ping":
        this.sendTo(socket, { t: "pong" });
        break;
      default:
        break;
    }
  }

  // Client side

  addClient(socket: RelaySocket, sessionHash: string): string {
    const id = `c${(this.nextClientNumber++).toString(36)}`;
    this.clients.set(id, {
      id,
      socket,
      sessionHash,
      pending: new Set(),
      terminals: new Set(),
      browsers: new Set(),
    });
    this.sendTo(socket, this.statusEvent());
    return id;
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    for (const rewritten of client.pending) {
      const pending = this.pending.get(rewritten);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(rewritten);
    }
    for (const sessionId of client.terminals) {
      if (this.unsubscribe(client, sessionId)) this.tellAgentToStop(sessionId);
    }
    // A browser on the Mac that nobody watches any more is closed with its tabs.
    for (const bid of client.browsers) {
      this.browserOwners.delete(bid);
      this.closeBrowser(bid);
    }
    client.browsers.clear();
  }

  /** Sends an event of the relay's own to every client. */
  sendEvent(event: string, data: unknown): void {
    this.broadcast({ t: "evt", event, data });
  }

  /** Closes every client connection that belongs to one of the given sessions. */
  closeSessions(sessionHashes: Iterable<string>): void {
    const ended = new Set(sessionHashes);
    for (const client of [...this.clients.values()]) {
      if (!ended.has(client.sessionHash)) continue;
      this.removeClient(client.id);
      client.socket.close(CLOSE_SESSION_ENDED, "session ended");
    }
  }

  handleClientMessage(id: string, data: string | Uint8Array): void {
    const client = this.clients.get(id);
    // Clients never send binary frames; those come from the agent only.
    if (!client || typeof data !== "string") return;
    const frame = parseFrame(data);
    if (!frame) return;
    switch (frame.t) {
      case "req":
        this.handleClientRequest(client, frame);
        break;
      case "ntf":
        if (typeof frame.method === "string" && this.agent) {
          this.sendTo(this.agent.socket, { t: "ntf", method: frame.method, params: frame.params });
        }
        break;
      case "ping":
        this.sendTo(client.socket, { t: "pong" });
        break;
      default:
        break;
    }
  }

  private handleClientRequest(client: Client, frame: Record<string, unknown>): void {
    const requestId = frame.id;
    if (typeof requestId !== "string" || requestId.length === 0) return;
    if (requestId.length > MAX_REQUEST_ID_LENGTH || typeof frame.method !== "string") {
      this.fail(
        client,
        requestId.slice(0, MAX_REQUEST_ID_LENGTH),
        "bad_request",
        "Malformed request",
      );
      return;
    }
    const rewritten = rewriteRequestId(client.id, requestId);
    if (this.pending.has(rewritten)) {
      this.fail(client, requestId, "bad_request", "A request with this id is still in flight");
      return;
    }
    const agent = this.agent;
    if (!agent) {
      this.fail(client, requestId, "agent_offline", "The Mac is not connected");
      return;
    }

    let subscribeTo: string | null = null;
    if (frame.method === "browser.close") {
      const bid = bidOf(frame.params);
      if (bid !== null && this.browserOwners.get(bid) === client) {
        this.browserOwners.delete(bid);
        client.browsers.delete(bid);
      }
    } else if (frame.method === "term.subscribe") {
      subscribeTo = sessionIdOf(frame.params);
      if (subscribeTo !== null) this.orphansReported.delete(subscribeTo);
    } else if (frame.method === "term.unsubscribe") {
      const sessionId = sessionIdOf(frame.params);
      if (sessionId !== null && !this.unsubscribe(client, sessionId)) {
        // Other clients still watch this session, so the agent keeps streaming.
        this.sendTo(client.socket, { t: "res", id: requestId, ok: true, result: {} });
        return;
      }
    }

    const timer = setTimeout(
      () => {
        this.pending.delete(rewritten);
        client.pending.delete(rewritten);
        this.fail(client, requestId, "timeout", "The Mac did not answer in time");
      },
      requestTimeout(frame.timeout_ms, this.requestTimeoutMs),
    );
    timer.unref();
    this.pending.set(rewritten, {
      client,
      clientRequestId: requestId,
      timer,
      subscribeTo,
      opensBrowser: frame.method === "browser.open",
    });
    client.pending.add(rewritten);
    this.sendTo(agent.socket, {
      t: "req",
      id: rewritten,
      method: frame.method,
      params: frame.params ?? {},
    });
  }

  private handleAgentResponse(agent: Agent, frame: Record<string, unknown>): void {
    if (typeof frame.id !== "string") return;
    const own = this.ownRequests.get(frame.id);
    if (own) {
      clearTimeout(own.timer);
      this.ownRequests.delete(frame.id);
      own.resolve(frame);
      return;
    }
    if (frame.id === agent.infoRequestId) {
      if (frame.ok === true && isRecord(frame.result)) {
        agent.info = {
          name: optionalString(frame.result.name),
          version: optionalString(frame.result.version),
          hostname: optionalString(frame.result.hostname),
        };
      }
      this.announce(agent);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    pending.client.pending.delete(frame.id);

    if (pending.subscribeTo !== null && frame.ok === true) {
      this.subscribe(pending.client, pending.subscribeTo);
    }
    if (pending.opensBrowser && frame.ok === true) {
      const bid = bidOf(frame.result);
      if (bid !== null && this.clients.has(pending.client.id)) {
        this.browserOwners.set(bid, pending.client);
        pending.client.browsers.add(bid);
        this.orphanBrowsers.delete(bid);
      }
    }
    this.sendTo(pending.client.socket, { ...frame, id: pending.clientRequestId });
  }

  private handleAgentEvent(frame: Record<string, unknown>): void {
    if (typeof frame.event !== "string") return;
    if (frame.event === "previews.changed") this.previewsChanged();
    if (frame.event === "notify" && this.onNotify) {
      try {
        this.onNotify(frame.data);
      } catch (error) {
        this.log(`notify failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const event: EventFrame = { t: "evt", event: frame.event, data: frame.data ?? {} };
    if (frame.event.startsWith("browser.")) {
      this.routeBrowserEvent(frame.event, event);
      return;
    }
    const sessionId = frame.event.startsWith("term.") ? sessionIdOf(frame.data) : null;
    if (sessionId === null) {
      this.broadcast(event);
      return;
    }
    const watchers = this.subscribers.get(sessionId);
    if (!watchers) return;
    const text = JSON.stringify(event);
    for (const client of watchers) this.sendRaw(client.socket, text);
    if (frame.event === "term.closed") {
      for (const client of watchers) client.terminals.delete(sessionId);
      this.subscribers.delete(sessionId);
    }
  }

  private routeOutput(agent: Agent, frame: Uint8Array): void {
    const sessionId = readOutputFrameSessionId(frame);
    if (sessionId === null) return;
    const watchers = this.subscribers.get(sessionId);
    if (watchers) {
      for (const client of watchers) this.sendRaw(client.socket, frame);
      return;
    }
    // A subscription can outlive its client (it left, or its request timed out, before the agent
    // answered). Stop the stream once instead of receiving output nobody reads.
    if (!this.orphansReported.has(sessionId) && !this.hasPendingSubscribe(sessionId)) {
      this.orphansReported.add(sessionId);
      this.tellAgentToStop(sessionId, agent);
    }
  }

  /** A browser session's events go to the client that owns it, and to nobody else. */
  private routeBrowserEvent(name: string, event: EventFrame): void {
    const bid = bidOf(event.data);
    if (bid === null) return;
    const owner = this.browserOwners.get(bid);
    if (owner) this.sendTo(owner.socket, event);
    if (name === "browser.closed" && owner) {
      this.browserOwners.delete(bid);
      owner.browsers.delete(bid);
    }
  }

  /**
   * A picture of a browser session goes to its owner only. One that nobody owns (its client left,
   * or gave up waiting for `browser.open`) closes the session, once.
   */
  private routeBrowserFrame(agent: Agent, frame: Uint8Array): void {
    const bid = readBrowserFrameBid(frame);
    if (bid === null) return;
    const owner = this.browserOwners.get(bid);
    if (owner) {
      this.sendRaw(owner.socket, frame);
      return;
    }
    if (!this.orphanBrowsers.has(bid) && !this.hasPendingBrowserOpen()) {
      this.orphanBrowsers.add(bid);
      this.closeBrowser(bid, agent);
    }
  }

  private hasPendingBrowserOpen(): boolean {
    for (const pending of this.pending.values()) {
      if (pending.opensBrowser) return true;
    }
    return false;
  }

  /** Asks the agent to close a browser session; its answer is not waited for. */
  private closeBrowser(bid: number, agent: Agent | null = this.agent): void {
    if (!agent) return;
    this.sendTo(agent.socket, {
      t: "req",
      id: this.nextRelayRequestId(),
      method: "browser.close",
      params: { bid },
    });
  }

  private hasPendingSubscribe(sessionId: string): boolean {
    for (const pending of this.pending.values()) {
      if (pending.subscribeTo === sessionId) return true;
    }
    return false;
  }

  private subscribe(client: Client, sessionId: string): void {
    if (!this.clients.has(client.id)) return;
    let watchers = this.subscribers.get(sessionId);
    if (!watchers) {
      watchers = new Set();
      this.subscribers.set(sessionId, watchers);
    }
    watchers.add(client);
    client.terminals.add(sessionId);
  }

  /** Removes one subscription. Returns true when nobody watches the session afterwards. */
  private unsubscribe(client: Client, sessionId: string): boolean {
    client.terminals.delete(sessionId);
    const watchers = this.subscribers.get(sessionId);
    if (!watchers) return true;
    watchers.delete(client);
    if (watchers.size > 0) return false;
    this.subscribers.delete(sessionId);
    return true;
  }

  private tellAgentToStop(sessionId: string, agent: Agent | null = this.agent): void {
    if (!agent) return;
    this.sendTo(agent.socket, {
      t: "req",
      id: this.nextRelayRequestId(),
      method: "term.unsubscribe",
      params: { session_id: sessionId },
    });
  }

  private announce(agent: Agent): void {
    clearTimeout(agent.infoTimer);
    if (this.agent !== agent || agent.announced) return;
    agent.announced = true;
    this.broadcast(this.statusEvent());
    void this.loadPreviews();
  }

  // Previews

  /**
   * What is known about a preview: whether the Mac is there, and if so the preview as its list
   * says. A preview the list does not have is asked about once more, as it may be brand new.
   */
  async lookupPreview(id: string): Promise<PreviewLookup> {
    if (!this.agent) return { state: "offline" };
    const known = this.previews?.get(id);
    if (known) return { state: "found", preview: known };
    if (this.previews === null || Date.now() - this.previewsLoadedAt >= PREVIEW_REFRESH_MIN_MS) {
      await this.loadPreviews();
    }
    if (!this.agent) return { state: "offline" };
    const found = this.previews?.get(id);
    return found ? { state: "found", preview: found } : { state: "unknown" };
  }

  /** Opens a byte stream to one port of a preview. */
  openStream(previewId: string, port: number): Promise<TunnelStream> {
    return this.streams.open(previewId, port);
  }

  private previewsChanged(): void {
    if (this.previewsTimer !== null) return;
    this.previewsTimer = setTimeout(() => {
      this.previewsTimer = null;
      void this.loadPreviews(true);
    }, PREVIEWS_CHANGED_DELAY_MS);
    this.previewsTimer.unref();
  }

  /** Asks the agent for its previews. An app without previews has none. */
  private loadPreviews(force = false): Promise<void> {
    if (this.previewsLoading && !force) return this.previewsLoading;
    const loading = this.ownRequest("preview.list", {}).then((frame) => {
      if (frame === null) return;
      this.previewsLoadedAt = Date.now();
      const list =
        frame.ok === true && isRecord(frame.result) && Array.isArray(frame.result.previews)
          ? frame.result.previews
          : [];
      const previews = new Map<string, Preview>();
      for (const item of list) {
        if (isRecord(item) && isPreviewId(item.id) && isPort(item.port)) {
          previews.set(item.id, item as unknown as Preview);
        }
      }
      this.previews = previews;
    });
    this.previewsLoading = loading;
    void loading.finally(() => {
      if (this.previewsLoading === loading) this.previewsLoading = null;
    });
    return loading;
  }

  /** A request of the relay's own. Resolves with the answer, or null without one. */
  private ownRequest(method: string, params: object): Promise<Record<string, unknown> | null> {
    const agent = this.agent;
    if (!agent) return Promise.resolve(null);
    const id = this.nextRelayRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ownRequests.delete(id);
        resolve(null);
      }, OWN_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.ownRequests.set(id, { resolve, timer });
      this.sendTo(agent.socket, { t: "req", id, method, params });
    });
  }

  private dropAgent(agent: Agent): void {
    clearTimeout(agent.infoTimer);
    const wasAnnounced = agent.announced;
    this.agent = null;
    this.streams.dropAll("The Mac disconnected");
    for (const own of this.ownRequests.values()) {
      clearTimeout(own.timer);
      own.resolve(null);
    }
    this.ownRequests.clear();
    this.previews = null;
    this.previewsLoadedAt = 0;
    for (const [rewritten, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.client.pending.delete(rewritten);
      this.fail(pending.client, pending.clientRequestId, "agent_offline", "The Mac disconnected");
    }
    this.pending.clear();
    for (const client of this.clients.values()) {
      client.terminals.clear();
      client.browsers.clear();
    }
    this.subscribers.clear();
    // The Mac's browser sessions end with its connection.
    this.browserOwners.clear();
    this.orphanBrowsers.clear();
    this.orphansReported.clear();
    if (wasAnnounced) this.broadcast(this.statusEvent());
  }

  private statusEvent(): EventFrame {
    return { t: "evt", event: "agent.status", data: this.status() };
  }

  private nextRelayRequestId(): string {
    return rewriteRequestId(RELAY_PREFIX, String(this.nextRelayRequestNumber++));
  }

  private fail(client: Client, requestId: string, code: ErrorCode, message: string): void {
    const frame: ResponseFrame = { t: "res", id: requestId, ok: false, error: { code, message } };
    this.sendTo(client.socket, frame);
  }

  private broadcast(frame: EventFrame): void {
    const text = JSON.stringify(frame);
    for (const client of this.clients.values()) this.sendRaw(client.socket, text);
  }

  private sendTo(socket: RelaySocket, frame: object): void {
    this.sendRaw(socket, JSON.stringify(frame));
  }

  private sendRaw(socket: RelaySocket, data: string | Uint8Array): void {
    try {
      socket.send(data);
    } catch (error) {
      this.log(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
