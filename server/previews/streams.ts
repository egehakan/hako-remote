// Byte streams between the relay and the desktop app (docs/protocol.md, "Byte streams"): each one is
// a TCP connection the Mac opens to a preview's port, seen here as a Node duplex stream that an HTTP
// client can use as its socket.

import { Duplex } from "node:stream";
import {
  decodeStreamFrame,
  encodeStreamFrame,
  isStreamId,
  ReceiveWindow,
  SendWindow,
  STREAM_CHUNK_BYTES,
} from "../../shared/previews.ts";

/** What the hub needs of the agent connection. */
export type StreamTransport = {
  send(data: string | Uint8Array): void;
  /** Bytes queued on the connection and not yet written to the network. */
  bufferedAmount(): number;
};

export type StreamHubOptions = {
  /** The agent connection, or null while the Mac is offline. */
  transport: () => StreamTransport | null;
  idleMs?: number;
  maxPerPreview?: number;
  openTimeoutMs?: number;
  log?: (message: string) => void;
};

/** Why a stream could not be opened: the agent's `sclose` error code, or the relay's own reason. */
export class StreamOpenError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const STREAM_IDLE_MS = 120_000;
export const MAX_STREAMS_PER_PREVIEW = 64;
const OPEN_TIMEOUT_MS = 10_000;
/** Above this much queued on the agent connection, stream data waits. */
const AGENT_BUFFER_LIMIT = 4 * 1024 * 1024;
const SWEEP_MS = 10_000;

type PendingWrite = { data: Buffer; callback: (error?: Error | null) => void };

type Entry = {
  sid: number;
  previewId: string;
  stream: TunnelStream;
  opened: boolean;
  opening: {
    resolve: (stream: TunnelStream) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  sentClose: boolean;
  receivedClose: boolean;
  window: SendWindow;
  received: ReceiveWindow;
  writes: PendingWrite[];
  retry: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
  /** A WebSocket is kept open however quiet it is; the relay pings it instead. */
  websocket: boolean;
};

/**
 * A stream as a socket. Its methods beyond `Duplex` are the ones Node's HTTP client calls on a
 * socket; the hub does the keeping alive and the timing out itself.
 */
export class TunnelStream extends Duplex {
  readonly sid: number;
  readonly previewId: string;
  /** Payload received from the agent, counted to know how much of it has been read since. */
  pushedBytes = 0;
  ackedBytes = 0;
  private readonly hub: StreamHub;

  constructor(hub: StreamHub, sid: number, previewId: string) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024 });
    this.hub = hub;
    this.sid = sid;
    this.previewId = previewId;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (e?: Error | null) => void) {
    this.hub.write(this.sid, chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.hub.finish(this.sid);
    callback();
  }

  override _read(): void {
    this.hub.passedOn(this.sid);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.hub.abort(this.sid, error);
    callback(error);
  }

  /** Marks the stream as a WebSocket, which is never closed for being idle. */
  markWebSocket(): void {
    this.hub.markWebSocket(this.sid);
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(_ms: number, callback?: () => void): this {
    if (callback) this.removeListener("timeout", callback);
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

/** The relay's half of the stream protocol: opening, data both ways under flow control, closing. */
export class StreamHub {
  private readonly entries = new Map<number, Entry>();
  private readonly transport: () => StreamTransport | null;
  private readonly idleMs: number;
  private readonly maxPerPreview: number;
  private readonly openTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private nextSid = 1;

  constructor(options: StreamHubOptions) {
    this.transport = options.transport;
    this.idleMs = options.idleMs ?? STREAM_IDLE_MS;
    this.maxPerPreview = options.maxPerPreview ?? MAX_STREAMS_PER_PREVIEW;
    this.openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.sweeper = setInterval(() => this.sweep(), Math.min(SWEEP_MS, this.idleMs));
    this.sweeper.unref();
  }

  get size(): number {
    return this.entries.size;
  }

  countFor(previewId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.previewId === previewId) count += 1;
    return count;
  }

  /** Asks the Mac for a connection to one port of a preview. */
  open(previewId: string, port: number): Promise<TunnelStream> {
    const transport = this.transport();
    if (!transport)
      return Promise.reject(new StreamOpenError("agent_offline", "The Mac is offline"));
    if (this.countFor(previewId) >= this.maxPerPreview) {
      return Promise.reject(new StreamOpenError("busy", "Too many connections to this preview"));
    }
    const sid = this.allocateSid();
    const stream = new TunnelStream(this, sid, previewId);
    return new Promise<TunnelStream>((resolve, reject) => {
      const entry: Entry = {
        sid,
        previewId,
        stream,
        opened: false,
        opening: {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.fail(entry, new StreamOpenError("timeout", "The Mac did not open the connection"));
            this.sendText({ t: "sclose", sid, error: { code: "failed", message: "Timed out" } });
          }, this.openTimeoutMs),
        },
        sentClose: false,
        receivedClose: false,
        window: new SendWindow(),
        received: new ReceiveWindow(),
        writes: [],
        retry: null,
        lastActivity: Date.now(),
        websocket: false,
      };
      entry.opening!.timer.unref();
      this.entries.set(sid, entry);
      this.sendText({ t: "sopen", sid, preview: previewId, port });
    });
  }

  /** Takes a text frame from the agent. Returns true when it was one of the stream messages. */
  handleText(frame: Record<string, unknown>): boolean {
    if (frame.t !== "sopened" && frame.t !== "sclose" && frame.t !== "sack") return false;
    if (!isStreamId(frame.sid)) return true;
    const entry = this.entries.get(frame.sid);
    if (!entry) return true;
    entry.lastActivity = Date.now();
    switch (frame.t) {
      case "sopened":
        this.opened(entry);
        break;
      case "sack":
        if (!entry.window.acked(Number(frame.bytes))) {
          this.protocolError(entry, "acknowledged more than was sent");
        } else {
          this.pump(entry);
        }
        break;
      case "sclose":
        this.closed(entry, frame.error);
        break;
    }
    return true;
  }

  /** Takes a binary frame from the agent. Returns true when it was a stream data frame. */
  handleBinary(bytes: Uint8Array): boolean {
    const frame = decodeStreamFrame(bytes);
    if (!frame) return false;
    const entry = this.entries.get(frame.sid);
    if (!entry || entry.receivedClose) return true;
    if (!entry.opened) this.opened(entry);
    entry.lastActivity = Date.now();
    if (!entry.received.received(frame.payload.length)) {
      this.protocolError(entry, "sent more than the window allows");
      return true;
    }
    entry.stream.pushedBytes += frame.payload.length;
    entry.stream.push(Buffer.from(frame.payload));
    // Bytes read at once by a flowing consumer never wait in the buffer, so look again soon.
    setImmediate(() => this.passedOn(entry.sid));
    return true;
  }

  /** Ends every stream: the agent connection is gone. */
  dropAll(message: string): void {
    for (const entry of [...this.entries.values()]) {
      this.fail(entry, new StreamOpenError("agent_offline", message));
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.dropAll("The relay is stopping");
  }

  // Called by TunnelStream

  write(sid: number, data: Buffer, callback: (error?: Error | null) => void): void {
    const entry = this.entries.get(sid);
    if (!entry || entry.sentClose) {
      callback(new Error("The stream is closed"));
      return;
    }
    entry.writes.push({ data, callback });
    this.pump(entry);
  }

  finish(sid: number): void {
    const entry = this.entries.get(sid);
    if (!entry || entry.sentClose) return;
    entry.sentClose = true;
    this.sendText({ t: "sclose", sid });
    if (entry.receivedClose) this.forget(entry);
  }

  passedOn(sid: number): void {
    const entry = this.entries.get(sid);
    if (!entry || entry.receivedClose) return;
    const stream = entry.stream;
    const read = stream.pushedBytes - stream.readableLength - stream.ackedBytes;
    if (read <= 0) return;
    const ack = entry.received.passedOn(read, stream.readableLength === 0);
    stream.ackedBytes += read;
    if (ack > 0) this.sendText({ t: "sack", sid, bytes: ack });
  }

  abort(sid: number, error: Error | null): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    // Both sides closed in order: nothing is left to say.
    if (!(entry.sentClose && entry.receivedClose)) {
      this.sendText({
        t: "sclose",
        sid,
        error: { code: "failed", message: error?.message ?? "The browser closed the connection" },
      });
    }
    this.forget(entry, error ?? new Error("The stream was closed"));
  }

  markWebSocket(sid: number): void {
    const entry = this.entries.get(sid);
    if (entry) entry.websocket = true;
  }

  // Inside

  private allocateSid(): number {
    for (;;) {
      const sid = this.nextSid;
      this.nextSid = this.nextSid >= 0xffff_ffff ? 1 : this.nextSid + 1;
      if (!this.entries.has(sid)) return sid;
    }
  }

  private opened(entry: Entry): void {
    if (entry.opened) return;
    entry.opened = true;
    const opening = entry.opening;
    entry.opening = null;
    if (opening) {
      clearTimeout(opening.timer);
      opening.resolve(entry.stream);
    }
  }

  private closed(entry: Entry, error: unknown): void {
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      this.fail(
        entry,
        new StreamOpenError(
          typeof code === "string" ? code : "failed",
          typeof message === "string" ? message.slice(0, 300) : "The connection failed",
        ),
      );
      return;
    }
    if (!entry.opened) this.opened(entry);
    entry.receivedClose = true;
    entry.stream.push(null);
    if (entry.sentClose) this.forget(entry);
  }

  private pump(entry: Entry): void {
    if (entry.retry !== null) return;
    const transport = this.transport();
    while (entry.writes.length > 0) {
      if (!transport) {
        this.fail(entry, new StreamOpenError("agent_offline", "The Mac is offline"));
        return;
      }
      const room = entry.window.room;
      if (room === 0) return;
      if (transport.bufferedAmount() > AGENT_BUFFER_LIMIT) {
        entry.retry = setTimeout(() => {
          entry.retry = null;
          if (this.entries.get(entry.sid) === entry) this.pump(entry);
        }, 20);
        return;
      }
      const write = entry.writes[0];
      const size = Math.min(room, write.data.length, STREAM_CHUNK_BYTES);
      transport.send(encodeStreamFrame(entry.sid, write.data.subarray(0, size)));
      entry.window.sent(size);
      entry.lastActivity = Date.now();
      if (size === write.data.length) {
        entry.writes.shift();
        write.callback();
      } else {
        write.data = write.data.subarray(size);
      }
    }
  }

  private protocolError(entry: Entry, what: string): void {
    this.log(`stream ${entry.sid}: the Mac ${what}`);
    this.sendText({
      t: "sclose",
      sid: entry.sid,
      error: { code: "failed", message: `Flow control: ${what}` },
    });
    this.fail(entry, new Error(`The Mac ${what}`));
  }

  /** Ends a stream with an error, without telling the agent (callers do when it is theirs to). */
  private fail(entry: Entry, error: Error): void {
    if (this.entries.get(entry.sid) !== entry) return;
    const opening = entry.opening;
    this.forget(entry, error);
    if (opening) opening.reject(error);
    else entry.stream.destroy(error);
  }

  /** Drops the bookkeeping of a stream; whatever it still had queued fails. */
  private forget(entry: Entry, error: Error | null = null): void {
    if (this.entries.get(entry.sid) !== entry) return;
    this.entries.delete(entry.sid);
    if (entry.opening) clearTimeout(entry.opening.timer);
    entry.opening = null;
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = null;
    const writes = entry.writes;
    entry.writes = [];
    for (const write of writes) write.callback(error ?? new Error("The stream is closed"));
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.websocket || now - entry.lastActivity < this.idleMs) continue;
      this.sendText({ t: "sclose", sid: entry.sid, error: { code: "failed", message: "Idle" } });
      this.fail(entry, new Error("The connection was idle too long"));
    }
  }

  private sendText(frame: object): void {
    try {
      this.transport()?.send(JSON.stringify(frame));
    } catch (error) {
      this.log(`stream send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
