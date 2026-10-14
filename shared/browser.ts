// The Mac browser (docs/protocol.md, "Mac browser"): a Chrome on the Mac that the phone watches as a
// stream of pictures and drives with input. Shapes, the frame layout and the limits both ends share.
// Shared by the relay, the web client and the mock agent.

export const BROWSER_FRAME_TYPE = 0x03;
/** Bytes before the image in a frame: type, bid, frame number, CSS width, CSS height, format. */
export const BROWSER_FRAME_HEADER = 14;
/** Image formats a frame names in its byte 13. */
export const FRAME_JPEG = 1;
export const FRAME_PNG = 2;

/** The device pixel ratios a viewport may ask for. */
export const SCALE_MIN = 1;
export const SCALE_MAX = 3;

export const BROWSER_CONSOLE_MAX = 200;
export const BROWSER_CONSOLE_TEXT_MAX = 2000;

/** The size and kind of device the Mac's browser pretends to be. Sizes are CSS pixels. */
export type BrowserViewport = {
  width: number;
  height: number;
  /** Device pixel ratio, 1 to 3. */
  scale: number;
  mobile: boolean;
  touch: boolean;
  user_agent?: string;
};

export type BrowserTab = { id: string; url: string; title: string; active: boolean };

export type BrowserOpenParams = {
  preview_id?: string;
  url?: string;
  viewport: BrowserViewport;
};
export type BrowserOpenResult = { bid: number; tabs: BrowserTab[] };

/** Event `browser.state`. `tab` is the active tab's id. */
export type BrowserState = {
  bid: number;
  tab: string;
  url: string;
  title: string;
  loading: boolean;
  can_back: boolean;
  can_forward: boolean;
  tabs: BrowserTab[];
};

/** CDP's modifier bits, as `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` take them. */
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export type TouchPoint = { x: number; y: number; id: number };
export type MouseButton = "none" | "left" | "middle" | "right";

/** One piece of input, in the order it happened. Coordinates are CSS pixels of the viewport. */
export type BrowserInputEvent =
  | { type: "touch"; phase: "start" | "move" | "end" | "cancel"; points: TouchPoint[] }
  | {
      type: "mouse";
      action: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button: MouseButton;
      clicks: number;
      dx: number;
      dy: number;
      modifiers: number;
    }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; code: string; modifiers: number; action: "press" | "down" | "up" };

export type BrowserInputParams = { bid: number; events: BrowserInputEvent[] };

export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";
/** Event `browser.dialog`. */
export type BrowserDialog = { bid: number; kind: DialogKind; message: string; default: string };

export type PickerOption = {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  /** The label of the `<optgroup>` the option is in, if any. */
  group?: string | null;
};
export type ValuePickerKind = "date" | "time" | "datetime-local" | "month" | "week" | "color";
/** Event `browser.picker`. */
export type BrowserPicker =
  | {
      bid: number;
      kind: "select";
      id: string;
      multiple: boolean;
      options: PickerOption[];
    }
  | {
      bid: number;
      kind: ValuePickerKind;
      id: string;
      value: string;
      min?: string | null;
      max?: string | null;
      step?: string | null;
    };

/** Event `browser.file_chooser`. `accept` is the input's `accept` attribute, "" without one. */
export type BrowserFileChooser = { bid: number; id: string; multiple: boolean; accept: string };

/** Event `browser.download`. `size` is in bytes, -1 while unknown. */
export type BrowserDownload = {
  bid: number;
  path: string;
  name: string;
  size: number;
  done: boolean;
};

export type ConsoleLevel = "error" | "warn" | "info" | "log" | "debug" | "network";
/** Event `browser.console`. `url` and `status` come with `network` entries. */
export type BrowserConsole = {
  bid: number;
  level: ConsoleLevel;
  text: string;
  source: string | null;
  line: number | null;
  url?: string;
  status?: number;
};

/** Event `browser.closed` (an addition to the specification): the session ended on the Mac. */
export type BrowserClosed = { bid: number; reason: string };

// Frames

export type BrowserFrame = {
  bid: number;
  frame: number;
  width: number;
  height: number;
  format: number;
  image: Uint8Array;
};

export function isBid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

export function encodeBrowserFrame(
  frame: Omit<BrowserFrame, "image">,
  image: Uint8Array,
): Uint8Array {
  const bytes = new Uint8Array(BROWSER_FRAME_HEADER + image.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = BROWSER_FRAME_TYPE;
  view.setUint32(1, frame.bid);
  view.setUint32(5, frame.frame);
  view.setUint16(9, Math.min(0xffff, Math.max(0, Math.round(frame.width))));
  view.setUint16(11, Math.min(0xffff, Math.max(0, Math.round(frame.height))));
  bytes[13] = frame.format;
  bytes.set(image, BROWSER_FRAME_HEADER);
  return bytes;
}

/** Reads only the session id, which is all the relay needs to route a frame. */
export function readBrowserFrameBid(bytes: Uint8Array): number | null {
  if (bytes.length < BROWSER_FRAME_HEADER || bytes[0] !== BROWSER_FRAME_TYPE) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
}

export function decodeBrowserFrame(bytes: Uint8Array): BrowserFrame | null {
  if (bytes.length < BROWSER_FRAME_HEADER || bytes[0] !== BROWSER_FRAME_TYPE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bid: view.getUint32(1),
    frame: view.getUint32(5),
    width: view.getUint16(9),
    height: view.getUint16(11),
    format: bytes[13],
    image: bytes.subarray(BROWSER_FRAME_HEADER),
  };
}

/** The bid in an event's data, for the relay to route `browser.*` events by. */
export function bidOf(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const bid = (data as { bid?: unknown }).bid;
  return isBid(bid) ? bid : null;
}

/**
 * What an address typed into the address field means: a full `http(s)` address as it is, a bare
 * host or `host:port` as `http://` (the Mac's own servers are what is usually typed), and null for
 * anything that is not an address.
 */
export function normalizeAddress(typed: string): string | null {
  const text = typed.trim();
  if (text === "" || /\s/.test(text)) return null;
  const withScheme =
    /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)
      ? text
      : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.href !== "about:blank") {
      return null;
    }
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname === "") return null;
    return url.href;
  } catch {
    return null;
  }
}
