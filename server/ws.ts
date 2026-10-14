import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_SESSION_ENDED,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
} from "../shared/protocol.ts";
import { bearerToken, isAllowedOrigin, safeEqual } from "./auth.ts";
import type { Config } from "./config.ts";
import type { PreviewProxy } from "./previews/proxy.ts";
import type { Relay, RelaySocket } from "./relay.ts";
import { cookieName, parseCookies, type SessionStore } from "./sessions.ts";

/** A client this far behind on reading is dropped; it reconnects and takes a fresh snapshot. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toPayload(data: RawData, isBinary: boolean): string | Uint8Array {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return isBinary ? new Uint8Array(buffer) : buffer.toString("utf8");
}

function asRelaySocket(ws: WebSocket): RelaySocket {
  return {
    send(data) {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate();
        return;
      }
      ws.send(data, { binary: typeof data !== "string" });
    },
    bufferedAmount: () => ws.bufferedAmount,
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

/**
 * Pings every 25 seconds and drops the connection after 60 seconds without any frame. `stillValid`
 * lets a client connection end as soon as its login session does.
 */
function keepAlive(ws: WebSocket, stillValid: () => boolean = () => true): void {
  let lastSeen = Date.now();
  const seen = () => {
    lastSeen = Date.now();
  };
  ws.on("message", seen);
  ws.on("pong", seen);
  ws.on("ping", seen);
  const timer = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
      ws.terminate();
    } else if (!stillValid()) {
      ws.close(CLOSE_SESSION_ENDED, "session ended");
    } else if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  ws.on("close", () => clearInterval(timer));
}

export function attachWebSockets(
  server: Server,
  deps: { config: Config; relay: Relay; sessions: SessionStore; previews: PreviewProxy | null },
): void {
  const { config, relay, sessions, previews } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const cookie = cookieName(config.secureCookies);

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = previews?.target(request);
    if (previews && target && target.kind !== "app") {
      previews.handleUpgrade(request, socket, head, target);
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://relay").pathname;

    if (pathname === "/ws/agent") {
      const token = bearerToken(request.headers.authorization);
      if (token === null || !safeEqual(token, config.agentKey)) {
        refuse(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const relaySocket = asRelaySocket(ws);
        keepAlive(ws);
        ws.on("message", (data, isBinary) =>
          relay.handleAgentMessage(relaySocket, toPayload(data, isBinary)),
        );
        ws.on("close", () => relay.detachAgent(relaySocket));
        ws.on("error", () => ws.terminate());
        relay.attachAgent(relaySocket);
      });
      return;
    }

    if (pathname === "/ws/client") {
      if (!isAllowedOrigin(request.headers.origin, config.origins)) {
        refuse(socket, 403, "Forbidden");
        return;
      }
      const sessionHash = sessions.resolve(parseCookies(request.headers.cookie).get(cookie));
      if (sessionHash === null) {
        refuse(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const relaySocket = asRelaySocket(ws);
        const id = relay.addClient(relaySocket, sessionHash);
        keepAlive(ws, () => sessions.isLive(sessionHash));
        ws.on("message", (data, isBinary) =>
          relay.handleClientMessage(id, toPayload(data, isBinary)),
        );
        ws.on("close", () => relay.removeClient(id));
        ws.on("error", () => ws.terminate());
      });
      return;
    }

    refuse(socket, 404, "Not Found");
  });
}
