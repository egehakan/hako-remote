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
//
// A folder can be added to the sample workspace for any directory of that tree, and a directory
// made in it. MOCK_FOLDERS=0 leaves `folder.create` and `fs.mkdir` out, as the desktop app before
// them would.
//
// Files travel in both directions through the transfer methods: downloads out of that tree, uploads
// into it, and uploads into a throwaway "uploads area" that is removed at exit. `kill -USR2` also
// rewrites Downloads/changes-while-read.bin, a file of several pieces. MOCK_TRANSFERS=0 leaves
// these methods out, and MOCK_UPLOAD_IDLE_MS shortens the 15 minutes an untouched upload is kept.
//
// The folders of that tree are git repositories, built at start with the real `git` command line,
// and the source control methods run git in them and refuse every repository outside the tree.
// MOCK_GIT=0 leaves those methods out, MOCK_GIT_EMPTY=1 answers that there are no repositories,
// MOCK_GIT_DELAY_MS=1500 makes every answer slow, and MOCK_GIT_NETWORK_DELAY_MS=25000 makes push
// and pull take longer than the relay waits for an ordinary request.
//
// A `notify` event is sent on demand: press w (an agent waits), d (an agent has finished), c (a long
// command has finished) or b (four in a second, to see the relay collapse them) in this console,
// or write one of those words to the file the mock agent names at start (MOCK_NOTIFY_FILE), with a
// session id after it to choose the terminal: `echo "agent_waiting sess-0007" > <file>`.

import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { encodeOutputFrame } from "../shared/frames.ts";
import { isNotifyKind, type NotifyEvent, type NotifyKind } from "../shared/notify.ts";
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
import { createGitFixture, createGitMethods, GitFailure } from "./mock-git.ts";
import {
  createFixture,
  createFsMethods,
  failure,
  FsFailure,
  removeFixture,
  resolveInFixture,
  rewriteChangingFile,
  rewriteConflictFile,
} from "./mock-files.ts";
import { createTransferMethods } from "./mock-transfers.ts";

const RELAY_URL = process.env.RELAY_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/ws/agent`;
const AGENT_KEY = process.env.HAKO_AGENT_KEY ?? "";
const FS_ENABLED = process.env.MOCK_FS !== "0";
const FS_DELAY_MS = Number(process.env.MOCK_FS_DELAY_MS ?? 0);
const TRANSFERS_ENABLED = FS_ENABLED && process.env.MOCK_TRANSFERS !== "0";
const FOLDERS_ENABLED = process.env.MOCK_FOLDERS !== "0";
const GIT_ENABLED = process.env.MOCK_GIT !== "0";
const GIT_DELAY_MS = Number(process.env.MOCK_GIT_DELAY_MS ?? 0);
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const SCROLLBACK_BYTES = 64 * 1024;
const SHELL_SCROLLBACK_BYTES = 512 * 1024;
const WORKSPACE_CHANGED_MIN_INTERVAL_MS = 500;
const NOTIFY_FILE = process.env.MOCK_NOTIFY_FILE ?? join(tmpdir(), "hako-mock-notify");
const NOTIFY_FILE_POLL_MS = 400;
const CLOSE_REPLACED = 4001;

if (AGENT_KEY === "") {
  console.error("HAKO_AGENT_KEY is not set. Put it in .env or pass it in the environment.");
  process.exit(1);
}

/** The home directory of the sample workspace: the root of the fixture tree. */
const HOME = createFixture();
const GIT_FIXTURE = GIT_ENABLED ? createGitFixture(HOME) : null;

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

/** A method answers at once or, when it has to wait for something, with a promise. */
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

const folderMethods: Record<string, Method> = FOLDERS_ENABLED
  ? {
      "folder.create": (params) => {
        const directory = params.directory;
        const real = resolveInFixture(HOME, directory);
        const shown = String(directory);
        try {
          if (!statSync(real).isDirectory()) {
            throw new FsFailure("not_a_directory", `${shown} is not a directory`);
          }
          accessSync(real, constants.R_OK | constants.X_OK);
        } catch (error) {
          throw failure(error, shown);
        }
        let window: Window | undefined;
        if (typeof params.window_id === "string") {
          window = windows.find((candidate) => candidate.id === params.window_id);
          if (!window) throw new RpcFailure("not_found", "No such window");
        } else {
          window = windows.find((candidate) => candidate.active) ?? windows[0];
        }
        if (!window) {
          window = { id: newId("win"), active: true, folders: [], tabs: [] };
          windows.push(window);
        }
        const existing = window.folders.find((folder) => folder.directory === shown);
        if (existing) return { folder_id: existing.id };
        const folder: Folder = {
          id: newId("folder"),
          name: shown === HOME ? "Home" : shown.slice(shown.lastIndexOf("/") + 1) || "/",
          directory: shown,
          color: null,
          icon: null,
        };
        window.folders.push(folder);
        workspaceChanged();
        return { folder_id: folder.id };
      },
    }
  : {};

const transfers = TRANSFERS_ENABLED
  ? createTransferMethods(HOME, {
      idleMs: process.env.MOCK_UPLOAD_IDLE_MS ? Number(process.env.MOCK_UPLOAD_IDLE_MS) : undefined,
      log: (line) => console.log(line),
    })
  : null;
const fsMethods: Record<string, Method> = FS_ENABLED
  ? { ...createFsMethods(HOME, () => windows), ...transfers?.methods }
  : {};
if (!FOLDERS_ENABLED) delete fsMethods["fs.mkdir"];
const gitMethods: Record<string, Method> = GIT_ENABLED
  ? createGitMethods(HOME, () => windows, {
      empty: process.env.MOCK_GIT_EMPTY === "1",
      networkDelayMs: Number(process.env.MOCK_GIT_NETWORK_DELAY_MS ?? 0),
      onChanged: (repo) => sendEvent("git.changed", { repo }),
    })
  : {};

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
  const delay = Object.hasOwn(fsMethods, frame.method)
    ? FS_DELAY_MS
    : Object.hasOwn(gitMethods, frame.method)
      ? GIT_DELAY_MS
      : 0;
  const method =
    methods[frame.method] ??
    folderMethods[frame.method] ??
    fsMethods[frame.method] ??
    gitMethods[frame.method];
  if (!method) {
    send({
      t: "res",
      id,
      ok: false,
      error: { code: "not_supported", message: `The mock agent has no ${frame.method}` },
    });
    return;
  }
  const fail = (error: unknown) => {
    const known =
      error instanceof RpcFailure || error instanceof FsFailure || error instanceof GitFailure;
    const message = error instanceof Error ? error.message : "Failed";
    send({ t: "res", id, ok: false, error: { code: known ? error.code : "failed", message } });
  };
  const answer = () => {
    try {
      const result = method(params);
      // An answer that is ready is sent in the same turn: a terminal's first output must not
      // overtake the answer to its `term.subscribe`.
      if (result instanceof Promise) {
        result.then((value) => send({ t: "res", id, ok: true, result: value }), fail);
      } else {
        send({ t: "res", id, ok: true, result });
      }
    } catch (error) {
      fail(error);
    }
  };
  if (delay > 0) setTimeout(answer, delay);
  else answer();
}

// Notifications

type Sample = { title: string; message: string };

/** `{agent}` stands for the name of the coding agent in the terminal. */
const NOTIFY_SAMPLES: Record<NotifyKind, Sample[]> = {
  agent_waiting: [
    { title: "{agent} needs your permission", message: "Allow Bash: pnpm test --filter relay?" },
    { title: "{agent} has a question", message: "Which of the two migrations should run first?" },
    { title: "{agent} needs your permission", message: "Allow Edit: server/push.ts?" },
    { title: "{agent} is waiting for you", message: "The plan is ready. Go ahead with it?" },
  ],
  agent_done: [
    {
      title: "{agent} has finished",
      message: "Fixed the login copy and ran the tests: 118 passed",
    },
    { title: "{agent} has finished", message: "Deployed the preview and ran the smoke checks" },
    { title: "{agent} has finished", message: "Renamed the module and updated its 14 imports" },
  ],
  command_done: [
    { title: "cargo build --release finished", message: "Took 2 min 14 s, exit status 0" },
    { title: "pnpm test failed", message: "Took 48 s, exit status 1" },
    { title: "rsync -a photos/ nas:photos/ finished", message: "Took 6 min 2 s, exit status 0" },
  ],
};

const NOTIFY_WORDS: Record<string, NotifyKind> = {
  w: "agent_waiting",
  waiting: "agent_waiting",
  d: "agent_done",
  done: "agent_done",
  c: "command_done",
  command: "command_done",
};

let notifyCount = 0;

type OwnedTerminal = { window: Window; tab: Tab; pane: Pane; sessionId: string };

function ownedTerminals(): OwnedTerminal[] {
  const owned: OwnedTerminal[] = [];
  for (const window of windows) {
    for (const item of window.tabs) {
      for (const pane of item.panes) {
        if (pane.session_id !== null && terminals.has(pane.session_id)) {
          owned.push({ window, tab: item, pane, sessionId: pane.session_id });
        }
      }
    }
  }
  return owned;
}

/**
 * Sends one `notify` for a terminal of this mock agent: the one named, or the next in turn. An
 * agent's notification also sets the status the workspace list shows, as the desktop app does.
 */
function emitNotify(kind: NotifyKind, sessionId?: string, sample?: Sample): void {
  const owned = ownedTerminals();
  // A command finishes in a plain terminal; an agent reports from one that runs an agent.
  const fitting = owned.filter((item) => (item.pane.agent === null) === (kind === "command_done"));
  const candidates = fitting.length > 0 ? fitting : owned;
  const target =
    sessionId === undefined
      ? candidates[notifyCount % Math.max(1, candidates.length)]
      : owned.find((item) => item.sessionId === sessionId);
  if (!target) {
    console.log(
      sessionId === undefined
        ? "notify: no terminal to notify about"
        : `notify: ${sessionId} is not a terminal of this mock agent`,
    );
    return;
  }
  const samples = NOTIFY_SAMPLES[kind];
  const chosen = sample ?? samples[notifyCount % samples.length];
  notifyCount += 1;
  const agent = target.pane.agent?.name ?? "Claude Code";
  const folder = target.window.folders.find((item) => item.id === target.tab.folder_id);
  const where = folder ? `${target.tab.title} in ${folder.name}` : target.tab.title;
  if (kind !== "command_done") {
    target.pane.agent = {
      name: agent,
      status: kind === "agent_waiting" ? "waiting" : "done",
      message: chosen.message,
    };
    workspaceChanged();
  }
  const event: NotifyEvent = {
    kind,
    title: chosen.title.replace("{agent}", agent),
    body: `${chosen.message}\n${where}`,
    session_id: target.sessionId,
    tab_id: target.tab.id,
  };
  sendEvent("notify", event);
  console.log(`notify: ${kind} for ${target.sessionId} (${where}): ${event.title}`);
}

/** Four notifications of one terminal within a second, which the relay turns into two. */
function emitBurst(): void {
  const target = ownedTerminals().find((item) => item.pane.agent !== null);
  if (!target) return;
  NOTIFY_SAMPLES.agent_waiting.forEach((sample, index) => {
    setTimeout(() => emitNotify("agent_waiting", target.sessionId, sample), index * 300);
  });
}

function notifyCommand(line: string): void {
  const [word, sessionId] = line.trim().split(/\s+/);
  if (!word) return;
  if (word === "b" || word === "burst") {
    emitBurst();
    return;
  }
  const kind = isNotifyKind(word) ? word : NOTIFY_WORDS[word];
  if (kind) emitNotify(kind, sessionId);
  else console.log(`notify: "${word}" is not one of w, d, c, b or a kind's name`);
}

function watchNotifyControls(): void {
  const poll = setInterval(() => {
    if (!existsSync(NOTIFY_FILE)) return;
    try {
      const text = readFileSync(NOTIFY_FILE, "utf8");
      rmSync(NOTIFY_FILE, { force: true });
      for (const line of text.split("\n")) notifyCommand(line);
    } catch (error) {
      console.error(`notify: could not read ${NOTIFY_FILE}: ${(error as Error).message}`);
    }
  }, NOTIFY_FILE_POLL_MS);
  poll.unref();

  if (!process.stdin.isTTY) return;
  // Single keys, so the terminal must hand them over as they are typed, Ctrl+C included.
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (keys: string) => {
    for (const key of keys) {
      if (key === "\u0003") stop();
      else if (key.trim() !== "") notifyCommand(key);
    }
  });
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
  transfers?.dispose();
  removeFixture(HOME);
  rmSync(NOTIFY_FILE, { force: true });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
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
  console.log(`rewrote ${rewriteChangingFile(HOME)}`);
});

console.log(
  FS_ENABLED
    ? `serving files from ${HOME} (pid ${process.pid})`
    : "the file methods are off (MOCK_FS=0)",
);

if (transfers) {
  console.log(`attached pictures are kept in ${transfers.uploadsRoot} until this stops`);
} else if (FS_ENABLED) {
  console.log("the transfer methods are off (MOCK_TRANSFERS=0)");
}

if (!FOLDERS_ENABLED) console.log("folder.create and fs.mkdir are off (MOCK_FOLDERS=0)");

if (GIT_FIXTURE) {
  console.log(
    `a teammate pushes to the remote of egehakan.com with: ${GIT_FIXTURE.teammateScript}`,
  );
} else {
  console.log("the source control methods are off (MOCK_GIT=0)");
}

if (SHELL_ENABLED) {
  console.log(
    `exposing a REAL shell in ${shellHome()} to ${RELAY_URL}; stop this when you are done`,
  );
}

console.log(
  `notifications: ${process.stdin.isTTY ? "press w (an agent waits), d (an agent has finished), c (a command has finished) or b (a burst) here, or " : ""}write agent_waiting, agent_done, command_done or burst to ${NOTIFY_FILE}`,
);
watchNotifyControls();

connect();
