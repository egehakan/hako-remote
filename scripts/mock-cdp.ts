// A small client for the Chrome DevTools protocol over one WebSocket, with flat sessions: what the
// mock agent's Mac browser (scripts/mock-browser.ts) needs to drive a headless Chrome.

import { WebSocket } from "ws";

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class CdpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<string, Set<Handler>>();
  /** Called once when the connection to Chrome is gone. */
  onClose: () => void = () => {};

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.receive(String(data)));
    socket.on("close", () => {
      for (const request of this.pending.values()) {
        request.reject(new CdpError(-1, "Chrome closed the connection"));
      }
      this.pending.clear();
      this.onClose();
    });
    socket.on("error", () => {});
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024,
      });
      socket.once("open", () => resolve(new Cdp(socket)));
      socket.once("error", reject);
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError(-1, "Not connected to Chrome"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    this.socket.close();
  }

  private receive(text: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
      sessionId?: string;
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new CdpError(message.error.code, message.error.message));
      else request.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    for (const handler of this.handlers.get(message.method) ?? []) {
      try {
        handler(message.params ?? {}, message.sessionId);
      } catch (error) {
        console.error(`cdp ${message.method}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
