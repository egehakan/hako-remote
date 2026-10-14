// The mock agent's previews: real dev servers on this computer, started at launch and stopped at
// exit, the preview methods, and the agent side of the byte streams (docs/protocol.md, "Previews").
//
// Three previews are always there: `demo` (scripts/mock-preview-server.ts site), `twoport`, a page
// and the API it calls on another port, and `lab`, a page of everything the Mac browser must
// handle. More come from MOCK_PREVIEWS, the path of a JSON file listing `{ id, name, directory,
// command, port, ports?, url_path?, env? }`; `{port}` in a command stands for its port.
// MOCK_PREVIEWS_OFF=1 leaves the preview methods out, as an older app would.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  decodeStreamFrame,
  encodeStreamFrame,
  isPreviewId,
  isStreamId,
  type Preview,
  type PreviewPort,
  previewPorts,
  ReceiveWindow,
  SendWindow,
  STREAM_CHUNK_BYTES,
} from "../shared/previews.ts";

export type LogTab = {
  tabId: string;
  sessionId: string;
  write(text: string): void;
  /** Ctrl+C typed into the tab. */
  onInterrupt: (() => void) | null;
  close(): void;
};

export type PreviewHost = {
  sendText(frame: object): void;
  sendBinary(data: Uint8Array): void;
  /** Opens a tab titled `Preview: <name>` whose terminal shows a dev server's output. */
  openLogTab(name: string, directory: string): LogTab;
  workspaceChanged(): void;
};

type Spec = {
  id: string;
  name: string;
  directory: string;
  command: string;
  port: number;
  ports: PreviewPort[];
  url_path: string;
  env: Record<string, string>;
};

type Running = {
  spec: Spec;
  preview: Preview;
  child: ChildProcess | null;
  tab: LogTab | null;
  readyTimer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
};

class MethodFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const SERVER_SCRIPT = fileURLToPath(new URL("./mock-preview-server.ts", import.meta.url));
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 180_000;
const CHANGED_MIN_INTERVAL_MS = 500;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Whether anything listens on a port, over IPv4 or IPv6: Vite, for one, listens on `localhost`,
 * which on a Mac can be `::1` alone.
 */
async function answers(port: number): Promise<boolean> {
  return (await answersOn(port, "127.0.0.1")) || answersOn(port, "::1");
}

function answersOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function readSpecs(file: string | undefined): Spec[] {
  if (!file) return [];
  const list = JSON.parse(readFileSync(file, "utf8")) as Partial<Spec>[];
  return list.map((item) => {
    if (
      !isPreviewId(item.id) ||
      typeof item.command !== "string" ||
      typeof item.port !== "number"
    ) {
      throw new Error(`MOCK_PREVIEWS: ${JSON.stringify(item)} needs an id, a command and a port`);
    }
    return {
      id: item.id,
      name: item.name ?? item.id,
      directory: item.directory ?? process.cwd(),
      command: item.command.replaceAll("{port}", String(item.port)),
      port: item.port,
      ports: item.ports ?? [{ port: item.port, label: "web" }],
      url_path: item.url_path ?? "/",
      env: item.env ?? {},
    };
  });
}

type Stream = {
  sid: number;
  socket: net.Socket | null;
  window: SendWindow;
  received: ReceiveWindow;
  /** Bytes from the dev server waiting for room in the window. */
  queued: Buffer[];
  sentClose: boolean;
  receivedClose: boolean;
  /** The dev server closed its side; `sclose` goes once the queue is empty. */
  ended: boolean;
  /** The TCP connection is gone altogether; the relay hears so once the queue is empty. */
  closed: boolean;
};

export async function createPreviewMock(host: PreviewHost, scratch: string) {
  const demoPort = await freePort();
  const webPort = await freePort();
  const apiPort = await freePort();
  const labPort = await freePort();
  const node = process.execPath;
  const specs: Spec[] = [
    {
      id: "demo",
      name: "Demo site",
      directory: scratch,
      command: `"${node}" "${SERVER_SCRIPT}" site ${demoPort}`,
      port: demoPort,
      ports: [{ port: demoPort, label: "web" }],
      url_path: "/",
      env: {},
    },
    {
      id: "twoport",
      name: "Web and API",
      directory: scratch,
      command: `"${node}" "${SERVER_SCRIPT}" two-port ${webPort} ${apiPort}`,
      port: webPort,
      ports: [
        { port: webPort, label: "web" },
        { port: apiPort, label: "api" },
      ],
      url_path: "/",
      env: {},
    },
    {
      id: "lab",
      name: "Browser lab",
      directory: scratch,
      command: `"${node}" "${SERVER_SCRIPT}" lab ${labPort}`,
      port: labPort,
      ports: [{ port: labPort, label: "web" }],
      url_path: "/",
      env: {},
    },
    ...readSpecs(process.env.MOCK_PREVIEWS),
  ];

  const previews = new Map<string, Running>();
  const streams = new Map<number, Stream>();
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastChangeAt = 0;

  const changed = () => {
    if (changeTimer) return;
    const wait = Math.max(0, lastChangeAt + CHANGED_MIN_INTERVAL_MS - Date.now());
    changeTimer = setTimeout(() => {
      changeTimer = null;
      lastChangeAt = Date.now();
      host.sendText({ t: "evt", event: "previews.changed", data: {} });
    }, wait);
  };

  const setStatus = (running: Running, status: Preview["status"], message: string | null) => {
    if (running.preview.status === status && running.preview.message === message) return;
    running.preview.status = status;
    running.preview.message = message;
    changed();
    if (status === "running") {
      host.sendText({
        t: "evt",
        event: "notify",
        data: {
          kind: "preview_ready",
          title: `Preview ready: ${running.preview.name}`,
          body: running.preview.directory,
          session_id: running.preview.session_id,
          tab_id: running.preview.tab_id,
          preview_id: running.preview.id,
        },
      });
    }
  };

  const start = (running: Running) => {
    const { spec } = running;
    if (!running.tab) {
      running.tab = host.openLogTab(spec.name, spec.directory);
      running.tab.onInterrupt = () => stop(running);
      running.preview.tab_id = running.tab.tabId;
      running.preview.session_id = running.tab.sessionId;
      host.workspaceChanged();
    }
    const tab = running.tab;
    tab.write(`\x1b[2m$ ${spec.command}\x1b[0m\r\n`);
    const child = spawn("/bin/sh", ["-c", `exec ${spec.command}`], {
      cwd: spec.directory,
      env: { ...process.env, PORT: String(spec.port), FORCE_COLOR: "1", ...spec.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.child = child;
    running.stopping = false;
    running.preview.started = Date.now();
    setStatus(running, "starting", null);
    const show = (chunk: Buffer) => tab.write(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
    child.stdout?.on("data", show);
    child.stderr?.on("data", show);
    const began = Date.now();
    running.readyTimer = setInterval(() => {
      void answers(spec.port).then((ok) => {
        if (running.child !== child || running.preview.status !== "starting") return;
        if (ok) {
          clearInterval(running.readyTimer!);
          running.readyTimer = null;
          setStatus(running, "running", null);
        } else if (Date.now() - began > READY_TIMEOUT_MS) {
          clearInterval(running.readyTimer!);
          running.readyTimer = null;
          setStatus(running, "failed", "The server did not answer within 3 minutes");
        }
      });
    }, READY_POLL_MS);
    child.on("exit", (code, signal) => {
      if (running.child !== child) return;
      running.child = null;
      if (running.readyTimer) clearInterval(running.readyTimer);
      running.readyTimer = null;
      tab.write(`\x1b[2m[exited ${signal ?? code}]\x1b[0m\r\n`);
      if (running.stopping) setStatus(running, "stopped", "Stopped from Hako");
      else if (running.preview.status === "starting") {
        setStatus(running, "failed", `The command exited (${signal ?? `status ${code}`})`);
      } else setStatus(running, "stopped", "The server stopped answering");
    });
  };

  const stop = (running: Running): Promise<void> => {
    const child = running.child;
    if (!child) return Promise.resolve();
    running.stopping = true;
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      try {
        process.kill(-child.pid!, "SIGINT");
      } catch {
        child.kill("SIGINT");
      }
      setTimeout(() => {
        if (running.child === child) {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 5_000).unref();
    });
  };

  for (const spec of specs) {
    const running: Running = {
      spec,
      preview: {
        id: spec.id,
        name: spec.name,
        directory: spec.directory,
        repo: null,
        port: spec.port,
        ports: spec.ports,
        command: spec.command,
        tab_id: null,
        session_id: null,
        status: "starting",
        message: null,
        started: Date.now(),
        url_path: spec.url_path,
      },
      child: null,
      tab: null,
      readyTimer: null,
      stopping: false,
    };
    previews.set(spec.id, running);
    start(running);
  }

  const find = (params: Record<string, unknown>): Running => {
    const found = typeof params.id === "string" ? previews.get(params.id) : undefined;
    if (!found) throw new MethodFailure("not_found", "No such preview");
    return found;
  };

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    "preview.list": () => ({
      previews: [...previews.values()]
        .map((running) => running.preview)
        .toSorted((a, b) => b.started - a.started),
    }),
    "preview.stop": async (params) => {
      const running = find(params);
      // As in Hako: Ctrl+C reaches the tab; the answer does not wait for the process to end.
      void stop(running);
      return {};
    },
    "preview.restart": async (params) => {
      const running = find(params);
      await stop(running);
      start(running);
      return {};
    },
    "preview.remove": async (params) => {
      const running = find(params);
      await stop(running);
      previews.delete(running.spec.id);
      running.tab?.close();
      host.workspaceChanged();
      changed();
      return {};
    },
  };

  // Streams

  const send = (stream: Stream) => {
    while (stream.queued.length > 0 && stream.window.room > 0) {
      const head = stream.queued[0];
      const size = Math.min(head.length, stream.window.room, STREAM_CHUNK_BYTES);
      host.sendBinary(encodeStreamFrame(stream.sid, head.subarray(0, size)));
      stream.window.sent(size);
      if (size === head.length) stream.queued.shift();
      else stream.queued[0] = head.subarray(size);
    }
    if (stream.queued.length === 0) {
      stream.socket?.resume();
      if ((stream.ended || stream.closed) && !stream.sentClose) {
        stream.sentClose = true;
        host.sendText({ t: "sclose", sid: stream.sid });
        if (stream.receivedClose) forget(stream);
      }
      // Nothing the relay still sends can reach the dev server any more: say so, or it waits.
      if (stream.closed && streams.get(stream.sid) === stream) {
        if (stream.receivedClose) forget(stream);
        else fail(stream, "failed", "The dev server closed the connection");
      }
    } else {
      stream.socket?.pause();
    }
  };

  const forget = (stream: Stream) => {
    streams.delete(stream.sid);
    stream.socket?.destroy();
  };

  const fail = (stream: Stream, code: string, message: string) => {
    if (streams.get(stream.sid) !== stream) return;
    host.sendText({ t: "sclose", sid: stream.sid, error: { code, message } });
    forget(stream);
  };

  const connect = (stream: Stream, port: number, hosts: string[]) => {
    const socket = net.connect({ port, host: hosts[0], allowHalfOpen: true });
    socket.once("connect", () => {
      if (streams.get(stream.sid) !== stream) {
        socket.destroy();
        return;
      }
      stream.socket = socket;
      host.sendText({ t: "sopened", sid: stream.sid });
      socket.on("data", (chunk: Buffer) => {
        stream.queued.push(chunk);
        send(stream);
      });
      socket.on("end", () => {
        stream.ended = true;
        send(stream);
      });
      socket.on("close", () => {
        if (streams.get(stream.sid) !== stream) return;
        stream.closed = true;
        send(stream);
      });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (stream.socket === null && hosts.length > 1 && error.code === "ECONNREFUSED") {
        connect(stream, port, hosts.slice(1));
        return;
      }
      fail(stream, "failed", error.message);
    });
  };

  const handleStreamText = (frame: Record<string, unknown>): boolean => {
    if (frame.t !== "sopen" && frame.t !== "sclose" && frame.t !== "sack") return false;
    if (!isStreamId(frame.sid)) return true;
    const sid = frame.sid;
    if (frame.t === "sopen") {
      const running = typeof frame.preview === "string" ? previews.get(frame.preview) : undefined;
      const port = typeof frame.port === "number" ? frame.port : running?.preview.port;
      const usable =
        running !== undefined &&
        (running.preview.status === "running" || running.preview.status === "starting") &&
        port !== undefined &&
        previewPorts(running.preview).includes(port);
      if (!usable) {
        host.sendText({
          t: "sclose",
          sid,
          error: { code: "not_found", message: "No such preview, or it is stopped" },
        });
        return true;
      }
      const stream: Stream = {
        sid,
        socket: null,
        window: new SendWindow(),
        received: new ReceiveWindow(),
        queued: [],
        sentClose: false,
        receivedClose: false,
        ended: false,
        closed: false,
      };
      streams.set(sid, stream);
      connect(stream, port, ["127.0.0.1", "::1"]);
      return true;
    }
    const stream = streams.get(sid);
    if (!stream) return true;
    if (frame.t === "sack") {
      if (!stream.window.acked(Number(frame.bytes))) {
        fail(stream, "failed", "Acknowledged more than was sent");
      } else {
        send(stream);
      }
      return true;
    }
    if (frame.error) {
      forget(stream);
      return true;
    }
    stream.receivedClose = true;
    stream.socket?.end();
    if (stream.sentClose) forget(stream);
    return true;
  };

  const handleBinary = (bytes: Uint8Array): void => {
    const frame = decodeStreamFrame(bytes);
    if (!frame) return;
    const stream = streams.get(frame.sid);
    if (!stream || !stream.socket || stream.receivedClose) return;
    if (!stream.received.received(frame.payload.length)) {
      fail(stream, "failed", "Sent more than the window allows");
      return;
    }
    const size = frame.payload.length;
    const socket = stream.socket;
    socket.write(frame.payload, () => {
      const ack = stream.received.passedOn(size, socket.writableLength === 0);
      if (ack > 0 && streams.get(stream.sid) === stream) {
        host.sendText({ t: "sack", sid: stream.sid, bytes: ack });
      }
    });
  };

  return {
    methods,
    handleStreamText,
    handleBinary,
    /** The relay is gone: every stream with it. */
    dropStreams(): void {
      for (const stream of [...streams.values()]) forget(stream);
    },
    list: () => [...previews.values()].map((running) => running.preview),
    /** Streams still open, for checking that every way of ending one releases it. */
    streamCount: () => streams.size,
    async dispose(): Promise<void> {
      for (const stream of [...streams.values()]) forget(stream);
      await Promise.all([...previews.values()].map((running) => stop(running)));
    },
  };
}

export { MethodFailure as PreviewFailure };
