// A stand-in for the Hako desktop app. It speaks the agent side of docs/protocol.md against an
// in-memory workspace, so the relay and the web client can be developed without a Mac running Hako.
//
//   pnpm mock-agent
//   RELAY_URL=wss://example.com/ws/agent HAKO_AGENT_KEY=... pnpm mock-agent
//
// One of its terminals is a REAL shell on this computer, started in a throwaway directory, so that
// full-screen programs can be tried. Whoever can log in to the relay can type into it. Against a
// relay on this computer the shell is on by default; against any other relay it needs MOCK_SHELL=1.
// MOCK_SHELL=0 turns it off, and MOCK_SHELL_DIR chooses the directory.
//
// `kill -USR1 <pid>` drops the next output frame of every terminal a client is watching, which is
// how to see a client recover from a gap.
//
// The file methods serve a throwaway tree that is built at start and removed at exit, and nothing
// outside it. The sample workspace lives in that tree, so its folders and working directories can
// be browsed. `kill -USR2 <pid>` rewrites fixtures/conflict.txt behind the client's back.
// MOCK_FS=0 leaves the file methods out, as an older desktop app would; MOCK_FS_DELAY_MS=1500
// makes them slow.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  createFixture,
  createFsMethods,
  FsFailure,
  removeFixture,
  rewriteConflictFile,
} from "./mock-files.ts";

const RELAY_URL = process.env.RELAY_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/ws/agent`;
const AGENT_KEY = process.env.HAKO_AGENT_KEY ?? "";
const FS_ENABLED = process.env.MOCK_FS !== "0";
const FS_DELAY_MS = Number(process.env.MOCK_FS_DELAY_MS ?? 0);
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const SCROLLBACK_BYTES = 64 * 1024;
const SHELL_SCROLLBACK_BYTES = 512 * 1024;
const WORKSPACE_CHANGED_MIN_INTERVAL_MS = 500;
const CLOSE_REPLACED = 4001;

if (AGENT_KEY === "") {
  console.error("HAKO_AGENT_KEY is not set. Put it in .env or pass it in the environment.");
  process.exit(1);
}

/** The home directory of the sample workspace: the root of the fixture tree. */
const HOME = createFixture();

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

/** What every mock terminal shares: the output stream, its offsets, and the snapshot. */
abstract class MockTerminal {
  readonly sessionId: string;
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;
  streaming = false;
  /** Set by SIGUSR1: the next output frame is lost on the way, as a flaky link would lose it. */
  dropNextFrame = false;
  private seq = 0;
  private scrollback = new Uint8Array(0);
  private truncated = false;
  private readonly scrollbackLimit: number;

  constructor(sessionId: string, scrollbackLimit: number) {
    this.sessionId = sessionId;
    this.scrollbackLimit = scrollbackLimit;
  }

  abstract input(data: string): void;
  protected abstract applySize(cols: number, rows: number): void;
  protected abstract dispose(): void;

  protected emit(bytes: Uint8Array): void {
    const start = this.seq;
    this.seq += bytes.length;
    const joined = new Uint8Array(this.scrollback.length + bytes.length);
    joined.set(this.scrollback);
    joined.set(bytes, this.scrollback.length);
    if (joined.length > this.scrollbackLimit) this.truncated = true;
    this.scrollback = joined.subarray(Math.max(0, joined.length - this.scrollbackLimit));
    if (!this.streaming || connection?.readyState !== WebSocket.OPEN) return;
    if (this.dropNextFrame) {
      this.dropNextFrame = false;
      console.log(`dropped ${bytes.length} bytes of ${this.sessionId} at offset ${start}`);
      return;
    }
    connection.send(encodeOutputFrame(this.sessionId, start, bytes));
  }

  /**
   * The snapshot is a replay of recent output, which is enough for a mock. The real app sends the
   * screen as its emulator holds it.
   */
  subscribe() {
    this.streaming = true;
    let recent = this.scrollback;
    if (this.truncated) {
      // The cut may have landed inside an escape sequence, so start at the next line.
      const newline = recent.indexOf(0x0a);
      if (newline !== -1) recent = recent.subarray(newline + 1);
    }
    return {
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      snapshot: Buffer.from(recent).toString("base64"),
    };
  }

  resize(cols: number, rows: number) {
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.applySize(cols, rows);
      sendEvent("term.size", { session_id: this.sessionId, cols, rows });
    }
    return { cols, rows };
  }

  /** Nobody is watching any more, so the Mac takes its own size back. */
  stopStreaming(): void {
    this.streaming = false;
    this.resize(DEFAULT_COLS, DEFAULT_ROWS);
  }

  /** Ends the session as closing its tab does, which subscribers are told about. */
  close(): void {
    this.dispose();
    if (this.streaming) sendEvent("term.closed", { session_id: this.sessionId });
    this.streaming = false;
  }

  /** Ends the session without a word, as when the whole app goes away. */
  abandon(): void {
    this.dispose();
    this.streaming = false;
  }
}

class FakeTerminal extends MockTerminal {
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(sessionId: string, cwd: string) {
    super(sessionId, SCROLLBACK_BYTES);
    this.write(`\x1b[2mmock session ${sessionId} in ${cwd}\x1b[0m\r\n`);
    this.timer = setInterval(() => {
      this.tick += 1;
      const time = new Date().toTimeString().slice(0, 8);
      this.write(`\x1b[33m${time}\x1b[0m  line ${this.tick}\r\n`);
    }, 1000);
  }

  private write(text: string): void {
    this.emit(encoder.encode(text));
  }

  /** Echoes input the way a line-mode shell would, so typing is visible. */
  input(data: string): void {
    this.write(`\x1b[36m${data.replaceAll("\r", "\r\n")}\x1b[0m`);
  }

  protected applySize(): void {}

  protected dispose(): void {
    clearInterval(this.timer);
  }
}

// The real shell

function shellWanted(): boolean {
  if (process.env.MOCK_SHELL === "0") return false;
  if (process.env.MOCK_SHELL === "1") return true;
  const host = new URL(RELAY_URL).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const SHELL_ENABLED = shellWanted();
const PTY_HELPER = fileURLToPath(new URL("./pty-helper.py", import.meta.url));
let shellDirectory: string | null = null;

/**
 * The directory real shells start in, with a prompt of its own instead of the owner's dotfiles:
 * the fixture tree, so that what the shell changes shows up in the file browser.
 */
function shellHome(): string {
  if (shellDirectory !== null) return shellDirectory;
  shellDirectory = process.env.MOCK_SHELL_DIR ?? HOME;
  mkdirSync(shellDirectory, { recursive: true });
  writeFileSync(
    join(shellDirectory, ".zshrc"),
    "PROMPT='%F{yellow}mock%f %1~ %# '\nunsetopt beep\nunset HISTFILE\n",
  );
  return shellDirectory;
}

class ShellTerminal extends MockTerminal {
  private readonly child: ChildProcess;
  /** Called when the shell exits by itself, so its tab can go too. */
  onExit: () => void = () => {};

  constructor(sessionId: string) {
    super(sessionId, SHELL_SCROLLBACK_BYTES);
    const home = shellHome();
    const shell = existsSync("/bin/zsh") ? ["/bin/zsh", "-i"] : ["/bin/sh", "-i"];
    this.child = spawn("python3", [PTY_HELPER, String(this.cols), String(this.rows), ...shell], {
      cwd: home,
      stdio: ["pipe", "pipe", "inherit", "pipe"],
      // A fresh environment: the mock agent's own holds the agent key and must not reach the shell.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        ZDOTDIR: home,
        HISTFILE: "/dev/null",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        SHELL: shell[0],
      },
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.emit(new Uint8Array(chunk)));
    this.child.stdin?.on("error", () => {});
    this.child.on("error", (error) => {
      console.error(`could not start the shell (python3 is needed): ${error.message}`);
    });
    this.child.on("exit", () => this.onExit());
  }

  input(data: string): void {
    this.child.stdin?.write(data);
  }

  protected applySize(cols: number, rows: number): void {
    (this.child.stdio[3] as NodeJS.WritableStream | null)?.write(`${cols} ${rows}\n`);
  }

  protected dispose(): void {
    this.child.removeAllListeners("exit");
    this.child.kill("SIGTERM");
  }
}

const terminals = new Map<string, MockTerminal>();
let nextId = 1;

function newId(prefix: string): string {
  return `${prefix}-${(nextId++).toString(36).padStart(4, "0")}`;
}

function terminalPane(
  title: string,
  cwd: string,
  agent: Pane["agent"] = null,
  focused = true,
): Pane {
  const sessionId = newId("sess");
  terminals.set(sessionId, new FakeTerminal(sessionId, cwd));
  return { id: newId("pane"), kind: "terminal", title, focused, session_id: sessionId, cwd, agent };
}

function tab(title: string, folderId: string | null, panes: Pane[], active = false): Tab {
  return { id: newId("tab"), title, active, folder_id: folderId, panes };
}

/** A pane running a real shell. `cwd` is only what the workspace list shows for it. */
function shellPane(cwd: string): Pane {
  const sessionId = newId("sess");
  const terminal = new ShellTerminal(sessionId);
  terminal.onExit = () => {
    console.log(`the shell of ${sessionId} exited`);
    for (const window of windows) {
      const owner = window.tabs.find((item) => item.panes.some((p) => p.session_id === sessionId));
      if (owner) removeTab(window, owner);
    }
  };
  terminals.set(sessionId, terminal);
  return {
    id: newId("pane"),
    kind: "terminal",
    title: "zsh",
    focused: true,
    session_id: sessionId,
    cwd,
    agent: null,
  };
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
        ...(SHELL_ENABLED ? [tab("real shell", null, [shellPane(shellHome())])] : []),
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

/** Takes a tab out of its window, ends its terminals and moves the active mark to a neighbour. */
function removeTab(window: Window, closed: Tab): void {
  const index = window.tabs.indexOf(closed);
  if (index === -1) return;
  window.tabs.splice(index, 1);
  for (const pane of closed.panes) {
    if (pane.session_id === null) continue;
    terminals.get(pane.session_id)?.close();
    terminals.delete(pane.session_id);
  }
  if (closed.active) {
    const neighbour = window.tabs[Math.min(index, window.tabs.length - 1)];
    if (neighbour) neighbour.active = true;
  }
  workspaceChanged();
}

function activate(window: Window, tabId: string): void {
  for (const candidate of windows) candidate.active = candidate === window;
  for (const candidate of window.tabs) candidate.active = candidate.id === tabId;
}

function terminalFor(params: Record<string, unknown>): MockTerminal {
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
      "#1B1E26",
      "#E0685A",
      "#8DBF9B",
      "#E8B45E",
      "#6C9BD1",
      "#B48EAD",
      "#6FB5B5",
      "#C9C5BB",
      "#565B69",
      "#F08A7D",
      "#A9D5B5",
      "#F6C984",
      "#8FB7E3",
      "#CBA6C6",
      "#8FCFCF",
      "#F2EEE6",
    ],
  },
  font_family: "Hack",
  font_size: 13,
};

type Method = (params: Record<string, unknown>) => unknown;

const methods: Record<string, Method> = {
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
    // A real shell never starts in the directory the workspace names: that would be a real folder.
    const pane = SHELL_ENABLED ? shellPane(directory) : terminalPane("zsh", directory);
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
    // The real app refuses to close a tab with unsaved edits; here every open file counts as one.
    const unsaved = found.tab.panes.find((pane) => pane.kind === "file");
    if (unsaved) {
      throw new RpcFailure(
        "failed",
        `${unsaved.title} has unsaved changes. Save or discard them on your Mac first.`,
      );
    }
    removeTab(found.window, found.tab);
    return {};
  },

  "term.subscribe": (params) => terminalFor(params).subscribe(),

  "term.unsubscribe": (params) => {
    terminals.get(String(params.session_id ?? ""))?.stopStreaming();
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

const fsMethods: Record<string, Method> = FS_ENABLED ? createFsMethods(HOME, () => windows) : {};

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

  const id = frame.id;
  const slow = FS_DELAY_MS > 0 && Object.hasOwn(fsMethods, frame.method);
  const method = methods[frame.method] ?? fsMethods[frame.method];
  if (!method) {
    send({
      t: "res",
      id,
      ok: false,
      error: { code: "not_supported", message: `The mock agent has no ${frame.method}` },
    });
    return;
  }
  const answer = () => {
    try {
      send({ t: "res", id, ok: true, result: method(params) });
    } catch (error) {
      const known = error instanceof RpcFailure || error instanceof FsFailure;
      const message = error instanceof Error ? error.message : "Failed";
      send({ t: "res", id, ok: false, error: { code: known ? error.code : "failed", message } });
    }
  };
  if (slow) setTimeout(answer, FS_DELAY_MS);
  else answer();
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
    // With the relay gone nobody is subscribed, which also gives every terminal its own size back.
    for (const terminal of terminals.values()) terminal.stopStreaming();
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
  // To a client this must look like a Mac that went offline, not like terminals that ended.
  for (const terminal of terminals.values()) terminal.abandon();
  removeFixture(HOME);
  connection?.close(1000);
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGUSR1", () => {
  for (const terminal of terminals.values()) terminal.dropNextFrame = terminal.streaming;
});
process.on("SIGUSR2", () => {
  console.log(`rewrote ${rewriteConflictFile(HOME)}`);
});

console.log(
  FS_ENABLED
    ? `serving files from ${HOME} (pid ${process.pid})`
    : "the file methods are off (MOCK_FS=0)",
);

if (SHELL_ENABLED) {
  console.log(
    `exposing a REAL shell in ${shellHome()} to ${RELAY_URL}; stop this when you are done`,
  );
}

connect();
