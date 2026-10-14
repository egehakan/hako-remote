// Previews (docs/protocol.md, "Previews"): the registry's shapes, preview ids, the byte stream frame
// and its flow control, and the messages between a preview page and the app. Shared by the relay,
// the web client and the mock agent.

export const PREVIEW_ID_MAX = 40;

/** Labels that are never a preview, so that these names stay free for the service itself. */
export const RESERVED_PREVIEW_IDS: readonly string[] = [
  "www",
  "api",
  "app",
  "admin",
  "relay",
  "hako",
  "mail",
  "static",
  "assets",
];

/**
 * 1 to 40 characters of `[a-z0-9-]`, not starting or ending with `-`, without `--` (which separates
 * an id from a port in a host name), and not a reserved label.
 */
export function isPreviewId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PREVIEW_ID_MAX &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) &&
    !value.includes("--") &&
    !RESERVED_PREVIEW_IDS.includes(value)
  );
}

export function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export type PreviewStatus = "starting" | "running" | "stopped" | "failed";

export type PreviewPort = { port: number; label: string };

export type Preview = {
  id: string;
  name: string;
  directory: string;
  repo: string | null;
  port: number;
  /** Every port the browser may need, the main one included. */
  ports: PreviewPort[];
  /** Null for a server that was attached while already running. */
  command: string | null;
  tab_id: string | null;
  session_id: string | null;
  status: PreviewStatus;
  /** A short sentence for `failed` and `stopped`, else null. */
  message: string | null;
  started: number;
  /** The path to open first. */
  url_path: string;
};

export type PreviewListResult = { previews: Preview[] };

/**
 * The ports of a preview as the relay uses them: the main port first, then the others, each once.
 * Reads what an agent sent defensively; an older or partial `Preview` has its main port only.
 */
export function previewPorts(preview: Pick<Preview, "port"> & { ports?: unknown }): number[] {
  const ports = [preview.port];
  if (Array.isArray(preview.ports)) {
    for (const item of preview.ports) {
      const port =
        typeof item === "object" && item !== null ? (item as { port?: unknown }).port : null;
      if (isPort(port) && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

/** The answer to `POST /api/previews/ticket`. */
export type PreviewTicket = { url: string };

// Byte streams

export const STREAM_FRAME_TYPE = 0x02;
/** Payload one side may have sent on a stream that the other side has not acknowledged. */
export const STREAM_WINDOW_BYTES = 512 * 1024;
/** The largest payload put in one frame. */
export const STREAM_CHUNK_BYTES = 64 * 1024;
/** A receiver acknowledges once this much has been passed on, or when it has passed on everything. */
export const STREAM_ACK_BYTES = 32 * 1024;

const SID_MAX = 0xffff_ffff;

export function isStreamId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SID_MAX;
}

export function encodeStreamFrame(sid: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = STREAM_FRAME_TYPE;
  new DataView(frame.buffer).setUint32(1, sid);
  frame.set(payload, 5);
  return frame;
}

export function decodeStreamFrame(frame: Uint8Array): { sid: number; payload: Uint8Array } | null {
  if (frame.length < 5 || frame[0] !== STREAM_FRAME_TYPE) return null;
  const sid = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  return { sid, payload: frame.subarray(5) };
}

/** The sending side of one stream's flow control: how much may still be sent before an ack. */
export class SendWindow {
  private inFlight = 0;
  private readonly limit: number;

  constructor(limit = STREAM_WINDOW_BYTES) {
    this.limit = limit;
  }

  /** Bytes that may be sent now. */
  get room(): number {
    return this.limit - this.inFlight;
  }

  get unacknowledged(): number {
    return this.inFlight;
  }

  /** Records bytes sent. Throws when they do not fit, which would be a bug of the sender. */
  sent(bytes: number): void {
    if (bytes > this.room) throw new RangeError("stream window exceeded");
    this.inFlight += bytes;
  }

  /** Records an ack. Returns false for an ack of more than was in flight, which the peer must not send. */
  acked(bytes: number): boolean {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.inFlight) return false;
    this.inFlight -= bytes;
    return true;
  }
}

/** The receiving side: bytes received and not yet acknowledged, and when to acknowledge them. */
export class ReceiveWindow {
  private held = 0;
  private passed = 0;
  private readonly limit: number;
  private readonly ackBytes: number;

  constructor(limit = STREAM_WINDOW_BYTES, ackBytes = STREAM_ACK_BYTES) {
    this.limit = limit;
    this.ackBytes = ackBytes;
  }

  /** Records bytes that arrived. Returns false when the peer sent more than its window allows. */
  received(bytes: number): boolean {
    if (this.held + bytes > this.limit) return false;
    this.held += bytes;
    return true;
  }

  /**
   * Records bytes passed on, and returns how many to acknowledge now: none until enough has
   * gathered, unless `drained` says nothing is waiting any more.
   */
  passedOn(bytes: number, drained: boolean): number {
    this.passed = Math.min(this.held, this.passed + bytes);
    if (this.passed === 0 || (this.passed < this.ackBytes && !drained)) return 0;
    const ack = this.passed;
    this.held -= ack;
    this.passed = 0;
    return ack;
  }
}

// What a preview page and the app tell each other (`/__hako/client.js`).

export const PREVIEW_MESSAGE_TYPE = "hako:preview";
export const PREVIEW_CONSOLE_MAX = 50;
export const PREVIEW_CONSOLE_TEXT_MAX = 2000;

export type PreviewConsoleLevel = "error" | "warn";

/** From the page to the app. */
export type PreviewPageMessage =
  | {
      type: typeof PREVIEW_MESSAGE_TYPE;
      kind: "location";
      url: string;
      title: string;
      width: number;
      height: number;
    }
  | {
      type: typeof PREVIEW_MESSAGE_TYPE;
      kind: "console";
      level: PreviewConsoleLevel;
      message: string;
      source: string | null;
      line: number | null;
    };

/** From the app to the page. */
export type PreviewCommand =
  | { type: typeof PREVIEW_MESSAGE_TYPE; kind: "back" | "forward" | "reload" }
  | { type: typeof PREVIEW_MESSAGE_TYPE; kind: "navigate"; path: string };

/** A path on the same origin: starts with one `/`, no backslash and no control characters. */
export function isSameOriginPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(value)
  );
}
