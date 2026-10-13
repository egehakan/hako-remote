// A stand-in for the Hako desktop app. It speaks the agent side of docs/protocol.md against an
// in-memory workspace, so the relay and the web client can be developed without a Mac running Hako.
//
//   pnpm mock-agent
//   RELAY_URL=wss://example.com/ws/agent HAKO_AGENT_KEY=... pnpm mock-agent

import { WebSocket } from "ws";
import { encodeOutputFrame } from "../shared/frames.ts";
import {
  type AppInfo,
  type ErrorCode,
  type Folder,
  IDLE_TIMEOUT_MS,
  type Pane,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  type Tab,
  type TerminalTheme,
  type Window,
} from "../shared/protocol.ts";

const RELAY_URL = process.env.RELAY_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/ws/agent`;
const AGENT_KEY = process.env.HAKO_AGENT_KEY ?? "";
const HOME = "/Users/ege";
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const SCROLLBACK_BYTES = 64 * 1024;
const WORKSPACE_CHANGED_MIN_INTERVAL_MS = 500;
const CLOSE_REPLACED = 4001;

if (AGENT_KEY === "") {
  console.error("HAKO_AGENT_KEY is not set. Put it in .env or pass it in the environment.");
  process.exit(1);
}

class RpcFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const encoder = new TextEncoder();
let connection: WebSocket | null = null;

function send(frame: object): void {
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify(frame));
}

function sendEvent(event: string, data: object): void {
  send({ t: "evt", event, data });
}

// Terminals

class FakeTerminal {
  readonly sessionId: string;
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;
  streaming = false;
  private seq = 0;
  private scrollback = new Uint8Array(0);
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.write(`\x1b[2mmock session ${sessionId} in ${cwd}\x1b[0m\r\n`);
    this.timer = setInterval(() => {
      this.tick += 1;
      const time = new Date().toTimeString().slice(0, 8);
      this.write(`\x1b[33m${time}\x1b[0m  line ${this.tick}\r\n`);
    }, 1000);
  }

  write(text: string): void {
    const bytes = encoder.encode(text);
    const start = this.seq;
    this.seq += bytes.length;
    const joined = new Uint8Array(this.scrollback.length + bytes.length);
    joined.set(this.scrollback);
    joined.set(bytes, this.scrollback.length);
    this.scrollback = joined.subarray(Math.max(0, joined.length - SCROLLBACK_BYTES));
    if (this.streaming && connection?.readyState === WebSocket.OPEN) {
      connection.send(encodeOutputFrame(this.sessionId, start, bytes));
    }
  }

  /** Echoes input the way a line-mode shell would, so typing is visible. */
  input(data: string): void {
    this.write(`\x1b[36m${data.replaceAll("\r", "\r\n")}\x1b[0m`);
  }

  subscribe() {
    this.streaming = true;
    return {
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      snapshot: Buffer.from(this.scrollback).toString("base64"),
    };
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    sendEvent("term.size", { session_id: this.sessionId, cols, rows });
    return { cols, rows };
  }

  close(): void {
    clearInterval(this.timer);
    if (this.streaming) sendEvent("term.closed", { session_id: this.sessionId });
    this.streaming = false;
  }
}

const terminals = new Map<string, FakeTerminal>();
let nextId = 1;

function newId(prefix: string): string {
  return `${prefix}-${(nextId++).toString(36).padStart(4, "0")}`;
}

function terminalPane(title: string, cwd: string, agent: Pane["agent"] = null, focused = true): Pane {
  const sessionId = newId("sess");
  terminals.set(sessionId, new FakeTerminal(sessionId, cwd));
  return { id: newId("pane"), kind: "terminal", title, focused, session_id: sessionId, cwd, agent };
}

function tab(title: string, folderId: string | null, panes: Pane[], active = false): Tab {
  return { id: newId("tab"), title, active, folder_id: folderId, panes };
}

// Workspace

function seedWorkspace(): Window[] {
  const hako: Folder = {
    id: newId("folder"),
    name: "hako",
    directory: `${HOME}/Documents/GitHub/hako`,
    color: "#E8923E",
    icon: "material:folder-app",
  };
  const remote: Folder = {
    id: newId("folder"),
    name: "hako-remote",
    directory: `${HOME}/Documents/GitHub/hako-remote`,
    color: "#5FA8D3",
    icon: "material:folder-server",
  };
  const notes: Folder = {
    id: newId("folder"),
    name: "Notes",
    directory: `${HOME}/Notes`,
    color: null,
    icon: "text:📓",
  };
  const site: Folder = {
    id: newId("folder"),
    name: "egehakan.com",
    directory: `${HOME}/Documents/GitHub/egehakan.com`,
    color: "#8DBF9B",
    icon: "material:folder-cloudflare",
  };

  return [
    {
      id: newId("win"),
      active: true,
      folders: [hako, remote, notes],
      tabs: [
        tab(
          "cargo run",
          hako.id,
          [
            terminalPane("cargo run", hako.directory, null, true),
            {
              id: newId("pane"),
              kind: "file",
              title: "tab_folders.rs",
              focused: false,
              session_id: null,
              cwd: null,
              agent: null,
            },
          ],
          true,
        ),
        tab("review remote protocol", hako.id, [
          terminalPane("aider", `${hako.directory}/app`, {
            name: "aider",
            status: "working",
            message: "Reading app/src/workspace/tab_folders.rs",
          }),
        ]),
        tab("relay", remote.id, [
          terminalPane("pnpm dev:server", remote.directory),
          terminalPane("pnpm dev", remote.directory, null, false),
        ]),
        tab("fix login copy", remote.id, [
          terminalPane("goose", remote.directory, {
            name: "goose",
            status: "waiting",
            message: "Allow running pnpm test?",
          }),
        ]),
        tab("htop", null, [terminalPane("htop", HOME)]),
        tab("ssh pi@garage", null, [terminalPane("ssh", HOME)]),
      ],
    },
    {
      id: newId("win"),
      active: false,
      folders: [site],
      tabs: [
        tab("deploy preview", site.id, [
          terminalPane("aider", site.directory, {
            name: "aider",
            status: "done",
            message: "Deployed the preview and ran the smoke checks",
          }),
        ]),
        tab("zsh", null, [terminalPane("zsh", `${HOME}/Downloads`)], true),
      ],
    },
  ];
}

const windows = seedWorkspace();

let lastChangeSentAt = 0;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

/** Announces a change at most twice a second, as the protocol asks. */
function workspaceChanged(): void {
  if (changeTimer) return;
  const wait = Math.max(0, lastChangeSentAt + WORKSPACE_CHANGED_MIN_INTERVAL_MS - Date.now());
  changeTimer = setTimeout(() => {
    changeTimer = null;
    lastChangeSentAt = Date.now();
    sendEvent("workspace.changed", {});
  }, wait);
}

function findTab(tabId: unknown): { window: Window; tab: Tab; index: number } {
  for (const window of windows) {
    const index = window.tabs.findIndex((candidate) => candidate.id === tabId);
    if (index !== -1) return { window, tab: window.tabs[index], index };
  }
  throw new RpcFailure("not_found", "No such tab");
}

function activate(window: Window, tabId: string): void {
  for (const candidate of windows) candidate.active = candidate === window;
  for (const candidate of window.tabs) candidate.active = candidate.id === tabId;
}

function terminalFor(params: Record<string, unknown>): FakeTerminal {
  const terminal = terminals.get(String(params.session_id ?? ""));
  if (!terminal) throw new RpcFailure("not_found", "No such terminal session");
  return terminal;
}

function dimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value > 1000) {
    throw new RpcFailure("bad_request", `${name} must be a whole number between 2 and 1000`);
  }
  return value;
}

const THEME: TerminalTheme = {
  terminal: {
    background: "#101116",
    foreground: "#D8D4CB",
    cursor: "#F6C984",
    selection: "#3A3226",
    ansi: [
      "#1B1E26", "#E0685A", "#8DBF9B", "#E8B45E", "#6C9BD1", "#B48EAD", "#6FB5B5", "#C9C5BB",
      "#565B69", "#F08A7D", "#A9D5B5", "#F6C984", "#8FB7E3", "#CBA6C6", "#8FCFCF", "#F2EEE6",
    ],
  },
  font_family: "Hack",
  font_size: 13,
};

const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
  "app.info": (): AppInfo => ({
    name: "Ege’s MacBook Pro",
    version: "0.1.0-mock",
    hostname: "eges-mbp.local",
    protocol: PROTOCOL_VERSION,
  }),

  "workspace.list": () => ({ windows }),

  "tab.create": (params) => {
    let window = windows.find((candidate) => candidate.active) ?? windows[0];
    let folder: Folder | null = null;
    if (typeof params.folder_id === "string") {
      const owner = windows.find((candidate) =>
        candidate.folders.some((item) => item.id === params.folder_id),
      );
      if (!owner) throw new RpcFailure("not_found", "No such folder");
      window = owner;
      folder = owner.folders.find((item) => item.id === params.folder_id) ?? null;
    } else if (typeof params.window_id === "string") {
      const chosen = windows.find((candidate) => candidate.id === params.window_id);
      if (!chosen) throw new RpcFailure("not_found", "No such window");
      window = chosen;
    }
    const directory =
      folder?.directory ?? (typeof params.directory === "string" ? params.directory : HOME);
    const pane = terminalPane("zsh", directory);
    const created = tab("zsh", folder?.id ?? null, [pane]);
    // A folder's tabs sit together: the new one goes after the folder's last tab.
    const lastInFolder = folder
      ? window.tabs.findLastIndex((item) => item.folder_id === folder.id)
      : -1;
    window.tabs.splice(lastInFolder === -1 ? window.tabs.length : lastInFolder + 1, 0, created);
    activate(window, created.id);
    workspaceChanged();
    return { tab_id: created.id, session_id: pane.session_id };
  },

  "tab.activate": (params) => {
    const found = findTab(params.tab_id);
    activate(found.window, found.tab.id);
    workspaceChanged();
    return {};
  },

  "tab.close": (params) => {
    const found = findTab(params.tab_id);
    found.window.tabs.splice(found.index, 1);
    for (const pane of found.tab.panes) {
      if (pane.session_id === null) continue;
      terminals.get(pane.session_id)?.close();
      terminals.delete(pane.session_id);
    }
    if (found.tab.active) {
      const neighbour = found.window.tabs[Math.min(found.index, found.window.tabs.length - 1)];
      if (neighbour) neighbour.active = true;
    }
    workspaceChanged();
    return {};
  },

  "term.subscribe": (params) => terminalFor(params).subscribe(),

  "term.unsubscribe": (params) => {
    const terminal = terminals.get(String(params.session_id ?? ""));
    if (terminal) {
      terminal.streaming = false;
      // Nobody is watching any more, so the Mac takes its own size back.
      terminal.cols = DEFAULT_COLS;
      terminal.rows = DEFAULT_ROWS;
    }
    return {};
  },

  "term.resize": (params) =>
    terminalFor(params).resize(dimension(params.cols, "cols"), dimension(params.rows, "rows")),

  "term.release_size": (params) => {
    terminalFor(params).resize(DEFAULT_COLS, DEFAULT_ROWS);
    return {};
  },

  "theme.get": () => THEME,
};

function handleFrame(text: string): void {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  const params = (
    typeof frame.params === "object" && frame.params !== null ? frame.params : {}
  ) as Record<string, unknown>;

  if (frame.t === "ntf") {
    if (frame.method === "term.input" && typeof params.data === "string") {
      terminals.get(String(params.session_id ?? ""))?.input(params.data);
    }
    return;
  }
  if (frame.t !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") return;

  const method = methods[frame.method];
  if (!method) {
    send({
      t: "res",
      id: frame.id,
      ok: false,
      error: { code: "not_supported", message: `The mock agent has no ${frame.method}` },
    });
    return;
  }
  try {
    send({ t: "res", id: frame.id, ok: true, result: method(params) });
  } catch (error) {
    const code = error instanceof RpcFailure ? error.code : "failed";
    const message = error instanceof Error ? error.message : "Failed";
    send({ t: "res", id: frame.id, ok: false, error: { code, message } });
  }
}

// Connection

let backoffMs = 1000;
let stopping = false;

function connect(): void {
  const ws = new WebSocket(RELAY_URL, { headers: { Authorization: `Bearer ${AGENT_KEY}` } });
  let lastSeen = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const seen = () => {
    lastSeen = Date.now();
  };

  ws.on("open", () => {
    connection = ws;
    backoffMs = 1000;
    console.log(`connected to ${RELAY_URL}`);
    heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) ws.terminate();
      else ws.ping();
    }, PING_INTERVAL_MS);
  });
  ws.on("ping", seen);
  ws.on("pong", seen);
  ws.on("message", (data, isBinary) => {
    seen();
    if (!isBinary) handleFrame(data.toString());
  });
  ws.on("unexpected-response", (_request, response) => {
    console.error(`relay refused the connection: HTTP ${response.statusCode}`);
    ws.terminate();
  });
  ws.on("error", (error) => {
    console.error(`connection error: ${error.message}`);
  });
  ws.on("close", (code) => {
    if (heartbeat) clearInterval(heartbeat);
    if (connection === ws) connection = null;
    for (const terminal of terminals.values()) terminal.streaming = false;
    if (stopping) return;
    // Another agent took this one's place: wait the full backoff instead of fighting over the slot.
    const wait = code === CLOSE_REPLACED ? 30_000 : backoffMs;
    console.log(`disconnected (code ${code}), retrying in ${wait / 1000}s`);
    setTimeout(connect, wait);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}

function stop(): void {
  stopping = true;
  connection?.close(1000);
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

connect();
