import { readOutputFrameSessionId } from "../shared/frames.ts";
import {
  type AgentStatus,
  CLOSE_REPLACED,
  CLOSE_SESSION_ENDED,
  type ErrorCode,
  type EventFrame,
  REQUEST_TIMEOUT_MS,
  type ResponseFrame,
} from "../shared/protocol.ts";

/** The part of a WebSocket the relay needs, so the routing can be tested without a network. */
export type RelaySocket = {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
};

export type RelayOptions = {
  requestTimeoutMs?: number;
  /** How long to wait for the agent's `app.info` before announcing it without a name. */
  infoTimeoutMs?: number;
  log?: (message: string) => void;
};

type Client = {
  id: string;
  socket: RelaySocket;
  sessionHash: string;
  /** Rewritten ids of this client's requests that the agent has not answered yet. */
  pending: Set<string>;
  /** Terminal sessions this client receives output for. */
  terminals: Set<string>;
};

type Pending = {
  client: Client;
  clientRequestId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set for `term.subscribe`: the session to start delivering once the agent says yes. */
  subscribeTo: string | null;
};

type Agent = {
  socket: RelaySocket;
  info: Omit<AgentStatus, "online"> | null;
  announced: boolean;
  infoRequestId: string;
  infoTimer: ReturnType<typeof setTimeout>;
};

const RELAY_PREFIX = "relay";
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

/** Rewrites a client's request id so ids from different connections cannot collide at the agent. */
export function rewriteRequestId(connectionId: string, clientRequestId: string): string {
  return `${connectionId}:${clientRequestId}`;
}

/**
 * Passes frames between the one agent and any number of clients. Apart from the terminal
 * subscription methods it has to track, it forwards method names and payloads without reading them.
 */
export class Relay {
  private readonly requestTimeoutMs: number;
  private readonly infoTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Map<string, Set<Client>>();
  /** Sessions the agent was already told to stop streaming because nobody is subscribed. */
  private readonly orphansReported = new Set<string>();
  private agent: Agent | null = null;
  private nextClientNumber = 1;
  private nextRelayRequestNumber = 1;

  constructor(options: RelayOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.infoTimeoutMs = options.infoTimeoutMs ?? INFO_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
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
      this.routeOutput(agent, data);
      return;
    }
    const frame = parseFrame(data);
    if (!frame) return;
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
    this.clients.set(id, { id, socket, sessionHash, pending: new Set(), terminals: new Set() });
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
    // Clients never send binary frames; those carry terminal output from the agent only.
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
      this.fail(client, requestId.slice(0, MAX_REQUEST_ID_LENGTH), "bad_request", "Malformed request");
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
    if (frame.method === "term.subscribe") {
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

    const timer = setTimeout(() => {
      this.pending.delete(rewritten);
      client.pending.delete(rewritten);
      this.fail(client, requestId, "timeout", "The Mac did not answer in time");
    }, this.requestTimeoutMs);
    timer.unref();
    this.pending.set(rewritten, { client, clientRequestId: requestId, timer, subscribeTo });
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
    this.sendTo(pending.client.socket, { ...frame, id: pending.clientRequestId });
  }

  private handleAgentEvent(frame: Record<string, unknown>): void {
    if (typeof frame.event !== "string") return;
    const event: EventFrame = { t: "evt", event: frame.event, data: frame.data ?? {} };
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
  }

  private dropAgent(agent: Agent): void {
    clearTimeout(agent.infoTimer);
    const wasAnnounced = agent.announced;
    this.agent = null;
    for (const [rewritten, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.client.pending.delete(rewritten);
      this.fail(pending.client, pending.clientRequestId, "agent_offline", "The Mac disconnected");
    }
    this.pending.clear();
    for (const client of this.clients.values()) client.terminals.clear();
    this.subscribers.clear();
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
