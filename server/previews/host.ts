import { isPort, isPreviewId } from "../../shared/previews.ts";
import type { PreviewAddressing } from "../config.ts";

/**
 * What a `Host` header names: the app (or any host that is not a preview's), one port of a preview
 * (`port` null for the main one), or a name under the preview domain that cannot be one (a reserved
 * label, a malformed one, or several labels).
 */
export type HostTarget =
  | { kind: "app" }
  | { kind: "preview"; id: string; port: number | null }
  | { kind: "invalid"; label: string };

/** Reads the preview a request is for from its `Host` header (port ignored, case folded). */
export function parsePreviewHost(
  host: string | undefined,
  addressing: PreviewAddressing | null,
): HostTarget {
  if (!host || addressing === null) return { kind: "app" };
  const hostname = host.trim().toLowerCase().replace(/:\d*$/, "").replace(/\.$/, "");
  const suffix = `.${addressing.domain}`;
  if (!hostname.endsWith(suffix)) return { kind: "app" };
  const label = hostname.slice(0, -suffix.length);
  if (isPreviewId(label)) return { kind: "preview", id: label, port: null };
  const match = /^(.+)--([1-9]\d{0,4})$/.exec(label);
  if (match && isPreviewId(match[1]) && isPort(Number(match[2]))) {
    return { kind: "preview", id: match[1], port: Number(match[2]) };
  }
  return { kind: "invalid", label: hostname.slice(0, -suffix.length).slice(0, 80) };
}

/** The origin of one port of a preview: its own name for the main port, `<id>--<port>` for others. */
export function previewOrigin(
  id: string,
  addressing: PreviewAddressing,
  port: number | null = null,
): string {
  const label = port === null ? id : `${id}--${port}`;
  return `${addressing.scheme}//${label}.${addressing.domain}${addressing.port}`;
}

/** The CSP source that matches every preview origin, for the app's `frame-src`. */
export function previewOriginPattern(addressing: PreviewAddressing): string {
  return `${addressing.scheme}//*.${addressing.domain}${addressing.port}`;
}

/**
 * The two-way map between a preview's ports on the Mac and its origins here: `http://localhost:P`,
 * `http://127.0.0.1:P` and `http://[::1]:P` (and their `ws:` forms) stand for the origin of P.
 */
export class PortMap {
  readonly id: string;
  /** Main port first. */
  readonly ports: readonly number[];
  private readonly addressing: PreviewAddressing;

  constructor(id: string, ports: readonly number[], addressing: PreviewAddressing) {
    this.id = id;
    this.ports = ports;
    this.addressing = addressing;
  }

  get mainPort(): number {
    return this.ports[0];
  }

  /** The preview origin of one of its ports, or null for a port it does not have. */
  originOf(port: number): string | null {
    if (!this.ports.includes(port)) return null;
    return previewOrigin(this.id, this.addressing, port === this.mainPort ? null : port);
  }

  /** Which port a preview origin of this preview stands for, or null for any other origin. */
  portOf(origin: string): number | null {
    for (const port of this.ports) {
      if (this.originOf(port) === origin) return port;
    }
    return null;
  }

  /** Every origin of this preview. */
  origins(): string[] {
    return this.ports.map((port) => this.originOf(port)!);
  }

  /**
   * Rewrites an absolute URL whose origin is a local form of one of the ports to the preview
   * origin of that port (`ws:` becoming `wss:` where the preview is served over HTTPS). Anything
   * else comes back unchanged.
   */
  toPublic(value: string): string {
    const parsed = parseUrl(value);
    if (parsed === null) return value;
    const { url, rest } = parsed;
    if (!LOCAL_HOSTS.has(url.hostname)) return value;
    const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
    const origin = port === null ? null : this.originOf(port);
    if (origin === null) return value;
    const secure = origin.startsWith("https:");
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      return `${secure ? "wss:" : "ws:"}${origin.slice(origin.indexOf("//"))}${rest}`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    return `${origin}${rest}`;
  }

  /** Rewrites a URL on one of this preview's origins to the `http://localhost:P` form. */
  toLocal(value: string): string {
    const parsed = parseUrl(value);
    if (parsed === null) return value;
    const port = this.portOf(parsed.url.origin);
    return port === null ? value : `http://localhost:${port}${parsed.rest}`;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function defaultPort(protocol: string): number | null {
  if (protocol === "http:" || protocol === "ws:") return 80;
  if (protocol === "https:" || protocol === "wss:") return 443;
  return null;
}

/** The URL and what follows its origin in the text as written (path, query and fragment). */
function parseUrl(value: string): { url: URL; rest: string } | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(value.trim());
  if (!match) return null;
  try {
    return { url: new URL(match[0]), rest: value.trim().slice(match[0].length) };
  } catch {
    return null;
  }
}
