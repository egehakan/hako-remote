// Serves the preview origins: the ticket exchange, the client script, and every other request and
// WebSocket tunnelled to the dev server on the Mac (docs/protocol.md, "Previews").

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { type Duplex, pipeline, Transform, type TransformCallback } from "node:stream";
import { isSameOriginPath, type Preview, previewPorts } from "../../shared/previews.ts";
import type { Config, PreviewAddressing } from "../config.ts";
import type { Relay } from "../relay.ts";
import { parseCookies, type SessionStore } from "../sessions.ts";
import {
  PREVIEW_COOKIE_TTL_MS,
  previewCookieName,
  signPreviewCookie,
  type TicketStore,
  verifyPreviewCookie,
} from "./access.ts";
import { clientScript } from "./client-script.ts";
import { type HostTarget, PortMap, parsePreviewHost } from "./host.ts";
import { type PreviewPage, pages, sendPage, sendPageOnSocket } from "./pages.ts";
import {
  CLIENT_SCRIPT_PATH,
  ClientScriptInjector,
  clientScriptTag,
  type Header,
  headerValues,
  rewriteRequestHeaders,
  rewriteResponseHeaders,
  wantsInjection,
} from "./rewrite.ts";
import { StreamOpenError, type TunnelStream } from "./streams.ts";

export const AUTH_PATH = "/__hako/auth";
export const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const WEBSOCKET_PING_MS = 25_000;

export type PreviewProxyDeps = {
  config: Config;
  relay: Relay;
  sessions: SessionStore;
  tickets: TicketStore;
  log?: (message: string) => void;
};

type Resolved =
  | { ok: true; preview: Preview; map: PortMap; port: number; origin: string }
  | { ok: false; page: PreviewPage };

function flatten(headers: readonly Header[]): string[] {
  return headers.flat();
}

/** Counts a request body on its way and fails it past the limit. */
class BodyLimit extends Transform {
  private seen = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.seen += chunk.length;
    if (this.seen > MAX_REQUEST_BODY_BYTES) callback(new Error("The request body is too large"));
    else callback(null, chunk);
  }
}

/**
 * Follows WebSocket frames going to the browser just closely enough to know where one ends, so a
 * ping can be put between two of them without cutting into either.
 */
class FrameBoundary {
  private header: number[] = [];
  private remaining = 0;

  get atBoundary(): boolean {
    return this.remaining === 0 && this.header.length === 0;
  }

  feed(chunk: Buffer): void {
    let index = 0;
    while (index < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - index);
        this.remaining -= take;
        index += take;
        continue;
      }
      this.header.push(chunk[index]);
      index += 1;
      const needed = this.headerLength();
      if (needed !== null && this.header.length === needed) {
        this.remaining = this.payloadLength();
        this.header = [];
      }
    }
  }

  private headerLength(): number | null {
    if (this.header.length < 2) return null;
    const masked = (this.header[1] & 0x80) !== 0;
    const short = this.header[1] & 0x7f;
    const extended = short === 126 ? 2 : short === 127 ? 8 : 0;
    return 2 + extended + (masked ? 4 : 0);
  }

  private payloadLength(): number {
    const short = this.header[1] & 0x7f;
    if (short < 126) return short;
    let length = 0;
    const bytes = short === 126 ? 2 : 8;
    for (let i = 0; i < bytes; i++) length = length * 256 + this.header[2 + i];
    return length;
  }
}

const WS_PING = Buffer.from([0x89, 0x00]);

export class PreviewProxy {
  private readonly config: Config;
  private readonly addressing: PreviewAddressing;
  private readonly relay: Relay;
  private readonly sessions: SessionStore;
  private readonly tickets: TicketStore;
  private readonly log: (message: string) => void;
  private readonly cookieName: string;
  private readonly appUrl: string;
  /** One HTTP client per port of a preview, keeping its connections for the next request. */
  private readonly agents = new Map<string, http.Agent>();
  /** Closers of the open WebSockets, by the login session that opened them. */
  private readonly sockets = new Map<string, Set<() => void>>();

  constructor(deps: PreviewProxyDeps) {
    if (deps.config.previews === null) throw new Error("previews need a preview domain");
    this.config = deps.config;
    this.addressing = deps.config.previews;
    this.relay = deps.relay;
    this.sessions = deps.sessions;
    this.tickets = deps.tickets;
    this.log = deps.log ?? (() => {});
    this.cookieName = previewCookieName(deps.config.secureCookies);
    this.appUrl = deps.config.origins[0];
  }

  target(request: IncomingMessage): HostTarget {
    return parsePreviewHost(request.headers.host, this.addressing);
  }

  /** Ends every WebSocket opened under these login sessions; HTTP requests check on their own. */
  closeSessions(sessionHashes: Iterable<string>): void {
    for (const hash of sessionHashes) {
      const closers = this.sockets.get(hash);
      if (!closers) continue;
      this.sockets.delete(hash);
      for (const close of closers) close();
    }
  }

  handleRequest(req: IncomingMessage, res: ServerResponse, target: HostTarget): void {
    void this.serve(req, res, target).catch((error: unknown) => {
      this.log(`preview request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendPage(res, pages.busy(), this.config.origins);
      else res.destroy();
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: HostTarget): void {
    socket.on("error", () => socket.destroy());
    void this.upgrade(req, socket, head, target).catch((error: unknown) => {
      this.log(`preview upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    });
  }

  private send(res: ServerResponse, page: PreviewPage): void {
    sendPage(res, page, this.config.origins);
  }

  private sessionOf(req: IncomingMessage): string | null {
    const value = parseCookies(req.headers.cookie).get(this.cookieName);
    const sessionHash = verifyPreviewCookie(value, this.config.sessionSecret);
    return sessionHash !== null && this.sessions.isLive(sessionHash) ? sessionHash : null;
  }

  private async serve(req: IncomingMessage, res: ServerResponse, target: HostTarget) {
    if (target.kind === "app") throw new Error("not a preview host");
    if (target.kind === "invalid") {
      this.send(res, pages.notFound(target.label, this.appUrl));
      return;
    }
    const url = new URL(req.url ?? "/", "http://preview");
    if (url.pathname === AUTH_PATH) {
      this.authorize(res, target.id, url);
      return;
    }
    const sessionHash = this.sessionOf(req);
    if (sessionHash === null) {
      this.send(res, pages.unauthorized(this.appUrl));
      return;
    }
    const resolved = await this.resolve(target.id, target.port);
    if (url.pathname === CLIENT_SCRIPT_PATH) {
      this.serveClientScript(res, resolved);
      return;
    }
    if (!resolved.ok) {
      this.send(res, resolved.page);
      return;
    }
    const length = Number(req.headers["content-length"] ?? 0);
    if (length > MAX_REQUEST_BODY_BYTES) {
      this.send(res, pages.tooLarge());
      return;
    }
    this.proxy(req, res, resolved);
  }

  /** Exchanges a ticket for the preview cookie and goes on to the page that was asked for. */
  private authorize(res: ServerResponse, id: string, url: URL): void {
    const sessionHash = this.tickets.redeem(url.searchParams.get("t"), id);
    if (sessionHash === null || !this.sessions.isLive(sessionHash)) {
      this.send(res, pages.unauthorized(this.appUrl, true));
      return;
    }
    const next = url.searchParams.get("next");
    const expiresAt = Date.now() + PREVIEW_COOKIE_TTL_MS;
    const value = signPreviewCookie(sessionHash, expiresAt, this.config.sessionSecret);
    const attributes = [
      `${this.cookieName}=${value}`,
      `Domain=${this.addressing.domain}`,
      "Path=/",
      `Max-Age=${Math.floor(PREVIEW_COOKIE_TTL_MS / 1000)}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(this.config.secureCookies ? ["Secure"] : []),
    ];
    res.writeHead(303, {
      Location: isSameOriginPath(next) ? next : "/",
      "Set-Cookie": attributes.join("; "),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Length": "0",
    });
    res.end();
  }

  private serveClientScript(res: ServerResponse, resolved: Resolved): void {
    const ports = resolved.ok
      ? resolved.map.ports.map((port) => ({ port, origin: resolved.map.originOf(port)! }))
      : [];
    const { source } = clientScript({ appOrigins: this.config.origins, ports });
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(source)),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(res.req.method === "HEAD" ? undefined : source);
  }

  /** Which preview and port a request is for, or the page that says why it cannot be served. */
  private async resolve(id: string, askedPort: number | null): Promise<Resolved> {
    const lookup = await this.relay.lookupPreview(id);
    if (lookup.state === "offline") return { ok: false, page: pages.offline() };
    if (lookup.state === "unknown") return { ok: false, page: pages.notFound(id, this.appUrl) };
    const preview = lookup.preview;
    const ports = previewPorts(preview);
    const map = new PortMap(id, ports, this.addressing);
    // The main port has one origin only: its own name, never `<id>--<main port>`.
    if (askedPort !== null && (askedPort === map.mainPort || !ports.includes(askedPort))) {
      return { ok: false, page: pages.noPort(id, askedPort, this.appUrl) };
    }
    const port = askedPort ?? map.mainPort;
    if (preview.status === "stopped" || preview.status === "failed") {
      return { ok: false, page: pages.stopped(preview.message) };
    }
    return { ok: true, preview, map, port, origin: map.originOf(port)! };
  }

  private failurePage(error: unknown, resolved: Extract<Resolved, { ok: true }>): PreviewPage {
    const code = error instanceof StreamOpenError ? error.code : "failed";
    switch (code) {
      case "agent_offline":
        return pages.offline();
      case "not_found":
        return pages.stopped(null);
      case "busy":
        return pages.busy();
      default:
        if (resolved.preview.status === "starting") return pages.starting();
        return pages.unreachable(
          resolved.port,
          error instanceof Error ? error.message : "The connection failed",
        );
    }
  }

  private agentFor(id: string, port: number): http.Agent {
    const key = `${id}:${port}`;
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8 });
      agent.createConnection = ((
        _options: unknown,
        callback: (e: Error | null, s?: Duplex) => void,
      ) => {
        this.relay.openStream(id, port).then(
          (stream) => callback(null, stream),
          (error: Error) => callback(error),
        );
        return undefined;
      }) as unknown as http.Agent["createConnection"];
      this.agents.set(key, agent);
    }
    return agent;
  }

  private proxy(
    req: IncomingMessage,
    res: ServerResponse,
    resolved: Extract<Resolved, { ok: true }>,
  ) {
    const { map, port, origin } = resolved;
    const headers = rewriteRequestHeaders(req.rawHeaders, {
      map,
      port,
      previewHost: req.headers.host ?? "",
      scheme: this.addressing.scheme,
      clientAddress: req.socket.remoteAddress ?? null,
      upgrade: null,
    });
    const upstream = http.request({
      agent: this.agentFor(map.id, port),
      method: req.method,
      path: req.url,
      headers: flatten(headers) as unknown as http.OutgoingHttpHeaders,
      setHost: false,
    });
    let answered = false;
    upstream.on("error", (error) => {
      if (!answered) {
        answered = true;
        this.send(res, this.failurePage(error, resolved));
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on("response", (answer) => {
      answered = true;
      const status = answer.statusCode ?? 502;
      let out = rewriteResponseHeaders(answer.rawHeaders, {
        map,
        previewDomain: this.addressing.domain,
        appOrigins: this.config.origins,
      });
      const tag = this.scriptTag(resolved);
      const inject = wantsInjection(out, status, origin);
      if (inject) {
        const length = headerValues(out, "content-length")[0];
        if (length !== undefined) {
          out = out.filter(([name]) => name.toLowerCase() !== "content-length");
          out.push(["Content-Length", String(Number(length) + Buffer.byteLength(tag))]);
        }
      }
      res.writeHead(status, answer.statusMessage, flatten(out));
      // A stream of events must reach the browser as it comes, headers first.
      res.flushHeaders();
      const bodyless = req.method === "HEAD" || status === 204 || status === 304;
      if (inject && !bodyless) {
        pipeline(answer, new ClientScriptInjector(tag), res, () => {});
      } else {
        pipeline(answer, res, () => {});
      }
    });
    pipeline(req, new BodyLimit(), upstream, (error) => {
      if (error && !answered) {
        answered = true;
        upstream.destroy();
        this.send(res, pages.tooLarge());
      }
    });
  }

  private scriptTag(resolved: Extract<Resolved, { ok: true }>): string {
    const ports = resolved.map.ports.map((port) => ({
      port,
      origin: resolved.map.originOf(port)!,
    }));
    const { version } = clientScript({ appOrigins: this.config.origins, ports });
    return clientScriptTag(resolved.map.id, version);
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: HostTarget) {
    const refuse = (page: PreviewPage) => sendPageOnSocket(socket, page, this.config.origins);
    if (target.kind === "app") throw new Error("not a preview host");
    if (target.kind === "invalid") {
      refuse(pages.notFound(target.label, this.appUrl));
      return;
    }
    const sessionHash = this.sessionOf(req);
    if (sessionHash === null) {
      refuse(pages.unauthorized(this.appUrl));
      return;
    }
    const resolved = await this.resolve(target.id, target.port);
    if (!resolved.ok) {
      refuse(resolved.page);
      return;
    }
    let stream: TunnelStream;
    try {
      stream = await this.relay.openStream(target.id, resolved.port);
    } catch (error) {
      refuse(this.failurePage(error, resolved));
      return;
    }
    if (socket.destroyed) {
      stream.destroy();
      return;
    }
    const headers = rewriteRequestHeaders(req.rawHeaders, {
      map: resolved.map,
      port: resolved.port,
      previewHost: req.headers.host ?? "",
      scheme: this.addressing.scheme,
      clientAddress: req.socket.remoteAddress ?? null,
      upgrade: req.headers.upgrade ?? "websocket",
    });
    const upstream = http.request({
      method: req.method,
      path: req.url,
      headers: flatten(headers) as unknown as http.OutgoingHttpHeaders,
      setHost: false,
      createConnection: () => stream,
    });
    const cleanup = () => {
      stream.destroy();
      socket.destroy();
    };
    socket.once("close", () => stream.destroy());
    upstream.on("error", () => {
      if (!socket.destroyed) refuse(pages.unreachable(resolved.port, "The WebSocket failed"));
      stream.destroy();
    });
    upstream.on("response", (answer) => {
      // Not upgraded: pass the dev server's answer on as it is, then close.
      const out = rewriteResponseHeaders(answer.rawHeaders, {
        map: resolved.map,
        previewDomain: this.addressing.domain,
        appOrigins: this.config.origins,
      });
      const lines = out.map(([name, value]) => `${name}: ${value}`).join("\r\n");
      socket.write(
        `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage ?? ""}\r\n${lines}\r\nConnection: close\r\n\r\n`,
      );
      answer.pipe(socket);
      answer.on("end", () => stream.destroy());
    });
    upstream.on("upgrade", (answer, tunnel, upstreamHead) => {
      stream.markWebSocket();
      const out = rewriteResponseHeaders(answer.rawHeaders, {
        map: resolved.map,
        previewDomain: this.addressing.domain,
        appOrigins: this.config.origins,
        upgrade: true,
      });
      const lines = out.map(([name, value]) => `${name}: ${value}`).join("\r\n");
      socket.write(
        `HTTP/1.1 101 ${answer.statusMessage ?? "Switching Protocols"}\r\n${lines}\r\n\r\n`,
      );
      this.pipeWebSocket(socket, tunnel, head, upstreamHead, sessionHash, cleanup);
    });
    upstream.end();
  }

  private pipeWebSocket(
    browser: Duplex,
    tunnel: Duplex,
    browserHead: Buffer,
    tunnelHead: Buffer,
    sessionHash: string,
    cleanup: () => void,
  ): void {
    const boundary = new FrameBoundary();
    const toBrowser = (chunk: Buffer) => {
      boundary.feed(chunk);
      if (!browser.write(chunk)) tunnel.pause();
    };
    browser.on("drain", () => tunnel.resume());
    if (tunnelHead.length > 0) toBrowser(tunnelHead);
    if (browserHead.length > 0) tunnel.write(browserHead);
    tunnel.on("data", toBrowser);
    browser.pipe(tunnel);
    let lastWrite = Date.now();
    tunnel.on("data", () => {
      lastWrite = Date.now();
    });
    const ping = setInterval(() => {
      // Only between two frames, and only when the dev server has been quiet.
      if (boundary.atBoundary && Date.now() - lastWrite >= WEBSOCKET_PING_MS - 1000) {
        browser.write(WS_PING);
      }
    }, WEBSOCKET_PING_MS);
    ping.unref();
    let closers = this.sockets.get(sessionHash);
    if (!closers) {
      closers = new Set();
      this.sockets.set(sessionHash, closers);
    }
    const close = () => cleanup();
    closers.add(close);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      closers.delete(close);
      if (closers.size === 0 && this.sockets.get(sessionHash) === closers) {
        this.sockets.delete(sessionHash);
      }
      cleanup();
    };
    tunnel.on("end", () => browser.end());
    tunnel.on("close", finish);
    browser.on("close", finish);
    tunnel.on("error", finish);
    browser.on("error", finish);
  }
}
