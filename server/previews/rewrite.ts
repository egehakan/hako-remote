// How a request to a preview origin is changed on its way to the dev server, and its response on the
// way back (docs/protocol.md, "Previews").

import { Transform, type TransformCallback } from "node:stream";
import { PREVIEW_COOKIE_NAMES } from "./access.ts";
import type { PortMap } from "./host.ts";

export type Header = [name: string, value: string];

/** Headers that belong to one connection and are never passed on. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Turns Node's `rawHeaders` (name, value, name, value…) into pairs. */
export function headerPairs(raw: readonly string[]): Header[] {
  const pairs: Header[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index], raw[index + 1]]);
  return pairs;
}

/** The hop-by-hop headers of a message: the fixed ones and those its `Connection` header names. */
function hopByHop(headers: readonly Header[]): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed !== "") names.add(trimmed);
    }
  }
  return names;
}

export type RequestRewrite = {
  map: PortMap;
  /** The dev server's port on the Mac that this request goes to. */
  port: number;
  /** The `Host` the browser sent: `myapp.hako.example.com`. */
  previewHost: string;
  /** `https:` or `http:`: how the browser reached the relay. */
  scheme: string;
  /** The address the request came from, as the relay's socket saw it. */
  clientAddress: string | null;
  /** The `Upgrade` header to keep, for a WebSocket handshake. */
  upgrade: string | null;
};

/** The cookie header without the preview cookie, or null when nothing else is left. */
export function withoutPreviewCookie(value: string): string | null {
  const kept = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part === "") return false;
      const eq = part.indexOf("=");
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      return !PREVIEW_COOKIE_NAMES.includes(name);
    });
  return kept.length === 0 ? null : kept.join("; ");
}

/**
 * The headers sent to the dev server. It sees itself addressed as `localhost:<port>` (which is what
 * Vite's `allowedHosts` and Next's `allowedDevOrigins` accept) and sees an `Origin` or `Referer` of
 * any port of its preview in its localhost form, exactly as on the Mac. It learns the public
 * address from the `X-Forwarded-*` headers, answers uncompressed so a page can be given the client
 * script, and never sees the preview cookie.
 */
export function rewriteRequestHeaders(raw: readonly string[], rewrite: RequestRewrite): Header[] {
  const pairs = headerPairs(raw);
  const drop = hopByHop(pairs);
  const forwardedFor: string[] = [];
  const out: Header[] = [];
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (drop.has(lower)) continue;
    switch (lower) {
      case "host":
      case "accept-encoding":
      case "forwarded":
      case "x-forwarded-host":
      case "x-forwarded-proto":
      case "x-forwarded-port":
        continue;
      case "x-forwarded-for":
        forwardedFor.push(value);
        continue;
      case "cookie": {
        const kept = withoutPreviewCookie(value);
        if (kept !== null) out.push([name, kept]);
        continue;
      }
      case "origin":
      case "referer":
        out.push([name, rewrite.map.toLocal(value)]);
        continue;
      default:
        out.push([name, value]);
    }
  }
  if (rewrite.clientAddress) forwardedFor.push(rewrite.clientAddress);
  out.unshift(["Host", `localhost:${rewrite.port}`]);
  out.push(["X-Forwarded-Host", rewrite.previewHost]);
  out.push(["X-Forwarded-Proto", rewrite.scheme.replace(":", "")]);
  if (forwardedFor.length > 0) out.push(["X-Forwarded-For", forwardedFor.join(", ")]);
  if (rewrite.upgrade !== null) {
    out.push(["Connection", "Upgrade"]);
    out.push(["Upgrade", rewrite.upgrade]);
  }
  return out;
}

export type ResponseRewrite = {
  map: PortMap;
  /** The domain every preview origin is under, which cookies are shared across. */
  previewDomain: string;
  /** The app's own origins, the only ones allowed to frame a preview. */
  appOrigins: readonly string[];
  /** Keeps `Connection` and `Upgrade`, for the answer to a WebSocket handshake. */
  upgrade?: boolean;
};

/** Cookies a preview may never set: the relay's own. */
const RESERVED_COOKIE_NAMES = [...PREVIEW_COOKIE_NAMES, "__Host-hako_session", "hako_session"];

/**
 * A cookie as a preview origin should store it, or null for one of the relay's own names. On the
 * Mac a cookie set by `localhost:8086` is sent to `localhost:8087` as well, since cookies ignore
 * ports; here those ports are separate hosts, so every cookie is set for the preview domain (in
 * place of whatever `Domain` it named), which every port of every preview shares, as every port of
 * localhost does. A `__Host-` cookie cannot have a domain and stays with its origin.
 */
export function rewriteSetCookie(value: string, previewDomain: string): string | null {
  const parts = value.split(";");
  const eq = parts[0].indexOf("=");
  const name = (eq === -1 ? "" : parts[0].slice(0, eq)).trim();
  if (RESERVED_COOKIE_NAMES.includes(name)) return null;
  const kept = parts.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part));
  if (!name.startsWith("__Host-")) kept.push(` Domain=${previewDomain}`);
  return kept.join(";");
}

/** A CSP without its `frame-ancestors` directive, or null when nothing else is left. */
export function withoutFrameAncestors(policy: string): string | null {
  const kept = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !/^frame-ancestors(\s|$)/i.test(directive));
  return kept.length === 0 ? null : kept.join("; ");
}

/** `5; url=http://localhost:8086/x` with its address mapped. */
function rewriteRefresh(value: string, map: PortMap): string {
  return value.replace(
    /(url\s*=\s*)(['"]?)([^'"\s]+)\2/i,
    (_all, prefix, quote, url) => `${prefix}${quote}${map.toPublic(url)}${quote}`,
  );
}

/** `<http://localhost:8087/a.js>; rel=preload, …` with every address mapped. */
function rewriteLink(value: string, map: PortMap): string {
  return value.replace(/<([^>]*)>/g, (_all, url: string) => `<${map.toPublic(url)}>`);
}

/**
 * The headers sent back to the browser: the hop-by-hop ones go, addresses of the dev servers'
 * localhost forms become preview origins, cookies are shared across the preview's ports, and only
 * the app may frame the page.
 */
export function rewriteResponseHeaders(raw: readonly string[], rewrite: ResponseRewrite): Header[] {
  const pairs = headerPairs(raw);
  const drop = hopByHop(pairs);
  const { map } = rewrite;
  const out: Header[] = [];
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (rewrite.upgrade && (lower === "connection" || lower === "upgrade")) {
      out.push([name, value]);
      continue;
    }
    if (drop.has(lower)) continue;
    switch (lower) {
      case "location":
      case "content-location":
      case "access-control-allow-origin":
        out.push([name, map.toPublic(value)]);
        continue;
      case "refresh":
        out.push([name, rewriteRefresh(value, map)]);
        continue;
      case "link":
        out.push([name, rewriteLink(value, map)]);
        continue;
      case "set-cookie": {
        const cookie = rewriteSetCookie(value, rewrite.previewDomain);
        if (cookie !== null) out.push([name, cookie]);
        continue;
      }
      case "x-frame-options":
        continue;
      case "content-security-policy":
      case "content-security-policy-report-only": {
        const policy = withoutFrameAncestors(value);
        if (policy !== null) out.push([name, policy]);
        continue;
      }
      default:
        out.push([name, value]);
    }
  }
  out.push(["Content-Security-Policy", `frame-ancestors ${rewrite.appOrigins.join(" ")}`]);
  return out;
}

export function headerValues(headers: readonly Header[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
}

// The client script

export const CLIENT_SCRIPT_PATH = "/__hako/client.js";

/** The tag put into a page: a plain script, so it runs before anything of the page's own. */
export function clientScriptTag(previewId: string, version: string): string {
  return `<script src="${CLIENT_SCRIPT_PATH}?p=${previewId}&amp;v=${version}"></script>`;
}

/**
 * Whether the page's own CSP lets it load a script from its own origin. Only the enforced
 * policies count; when in doubt the answer is no, and the page is left as it is.
 */
export function cspAllowsClientScript(policies: readonly string[], previewOrigin: string): boolean {
  const origin = new URL(previewOrigin);
  return policies.every((policy) => {
    const directives = new Map<string, string[]>();
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (!name) continue;
      const key = name.toLowerCase();
      if (!directives.has(key))
        directives.set(
          key,
          sources.map((s) => s.toLowerCase()),
        );
    }
    const sources =
      directives.get("script-src-elem") ??
      directives.get("script-src") ??
      directives.get("default-src");
    if (sources === undefined) return true;
    if (sources.includes("'strict-dynamic'")) return false;
    return sources.some((source) => sourceMatches(source, origin));
  });
}

function sourceMatches(source: string, origin: URL): boolean {
  if (source === "'self'" || source === "*") return true;
  if (source === origin.protocol) return true;
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(
    source,
  );
  if (!match) return false;
  const [, scheme, wildcard, host, port] = match;
  if (scheme !== undefined && `${scheme}:` !== origin.protocol) return false;
  const hostOk = wildcard ? origin.hostname.endsWith(`.${host}`) : origin.hostname === host;
  if (!hostOk) return false;
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  const originPort = origin.port === "" ? defaultPort : origin.port;
  return port === "*" || (port ?? defaultPort) === originPort;
}

/** Whether a response is a page the client script goes into. */
export function wantsInjection(
  headers: readonly Header[],
  status: number,
  previewOrigin: string,
): boolean {
  if (status < 200 || status === 204 || status === 304) return false;
  const type = headerValues(headers, "content-type")[0] ?? "";
  if (!/^\s*text\/html\b/i.test(type)) return false;
  const encoding = headerValues(headers, "content-encoding")[0]?.trim().toLowerCase() ?? "";
  if (encoding !== "" && encoding !== "identity") return false;
  return cspAllowsClientScript(headerValues(headers, "content-security-policy"), previewOrigin);
}

/** How much of a page is looked through for its `<head>` before giving up on finding one. */
export const INJECTION_SCAN_BYTES = 64 * 1024;

/**
 * Where the script tag goes in the start of a page, given as Latin-1 so offsets are byte offsets:
 * right after `<head …>`; without one, after `<html …>`; without that, after the doctype (before it
 * would put the page in quirks mode); and otherwise at the very start. Returns null while the text
 * seen so far could still turn out to have a `<head>` further on.
 */
export function injectionPoint(prefix: string, complete: boolean): number | null {
  const head = /<head(?:\s[^>]*)?>/i.exec(prefix);
  if (head) return head.index + head[0].length;
  const decided = complete || prefix.length >= INJECTION_SCAN_BYTES || /<body[\s>]/i.test(prefix);
  if (!decided) return null;
  const html = /<html(?:\s[^>]*)?>/i.exec(prefix);
  if (html) return html.index + html[0].length;
  const doctype = /^(?:﻿|\xef\xbb\xbf)?\s*<!doctype[^>]*>/i.exec(prefix);
  if (doctype) return doctype.index + doctype[0].length;
  return prefix.startsWith("\xef\xbb\xbf") ? 3 : 0;
}

/** Inserts the script tag into a page as it streams past, holding back only the page's start. */
export class ClientScriptInjector extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private done = false;
  private readonly tag: Buffer;

  constructor(tag: string) {
    super();
    this.tag = Buffer.from(tag, "latin1");
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.done) {
      callback(null, chunk);
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.tryInject(false);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.done) this.tryInject(true);
    callback();
  }

  private tryInject(complete: boolean): void {
    const joined = Buffer.concat(this.pending, this.pendingBytes);
    const at = injectionPoint(joined.toString("latin1"), complete);
    if (at === null) return;
    this.done = true;
    this.pending = [];
    this.push(Buffer.concat([joined.subarray(0, at), this.tag, joined.subarray(at)]));
  }
}

/** Injects into a whole page at once. */
export function injectClientScript(page: Buffer, tag: string): Buffer {
  const at = injectionPoint(page.toString("latin1"), true) ?? 0;
  return Buffer.concat([page.subarray(0, at), Buffer.from(tag, "latin1"), page.subarray(at)]);
}
