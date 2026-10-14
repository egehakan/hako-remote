// The mock agent's Mac browser (docs/protocol.md, "Mac browser"): a REAL headless Chrome on this
// computer, started on the first `browser.open` with a throwaway profile and its own debugging
// port, driven over the DevTools protocol, and stopped 15 minutes after its last session or when the
// mock agent stops. It never touches the Chrome you use.
//
// MOCK_BROWSER_CHROME names another Chrome binary (a path that does not exist shows the client's
// "Chrome not found"), MOCK_BROWSER_OFF=1 leaves the browser methods out, as an older app would,
// and MOCK_BROWSER_DEBUG=1 prints the sessions opened and closed and the tabs Chrome attaches.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_CONSOLE_MAX,
  BROWSER_CONSOLE_TEXT_MAX,
  type BrowserInputEvent,
  type BrowserTab,
  type BrowserViewport,
  encodeBrowserFrame,
  FRAME_JPEG,
  isBid,
  normalizeAddress,
  SCALE_MAX,
  SCALE_MIN,
} from "../shared/browser.ts";
import { Cdp } from "./mock-cdp.ts";

export class BrowserFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type BrowserHost = {
  sendEvent(event: string, data: object): void;
  sendBinary(data: Uint8Array): void;
  /** `http://localhost:<port><url_path>` of a running preview, or null for an unknown one. */
  previewUrl(id: string): string | null;
  /** Where downloads are kept: inside the tree the file methods serve, so `fs.download` reads them. */
  downloadsDir: string;
};

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IDLE_STOP_MS = 15 * 60_000;
const UNACKED_LIMIT_MS = 5 * 60_000;
const STATE_DELAY_MS = 30;
const INPUT_TIMEOUT_MS = 3_000;
const PICKER_WORLD = "hako";
const PICKER_BINDING = "__hakoPicker";

/**
 * Reports a `<select>` or a date, time or colour input the owner opens, from an isolated world, and
 * keeps the element so the reply can set it. Native pickers are not drawn into screencast frames.
 */
const PICKER_SCRIPT = `(() => {
  if (globalThis.__hakoPickerReady) return;
  globalThis.__hakoPickerReady = true;
  const VALUE_KINDS = ["date", "time", "datetime-local", "month", "week", "color"];
  const elements = new Map();
  globalThis.__hakoPickers = elements;
  let next = 1;
  let lastOpened = 0;
  const kindOf = (el) => {
    if (el instanceof HTMLSelectElement) return el.size > 1 ? null : "select";
    if (el instanceof HTMLInputElement && VALUE_KINDS.includes(el.type)) return el.type;
    return null;
  };
  const targetOf = (event) => {
    const el = event.target instanceof Element ? event.target.closest("select, input") : null;
    return el && kindOf(el) && !el.disabled && !el.readOnly ? el : null;
  };
  const open = (el) => {
    if (Date.now() - lastOpened < 300) return;
    lastOpened = Date.now();
    const kind = kindOf(el);
    const id = String(next++);
    elements.set(id, el);
    el.focus();
    const payload = kind === "select"
      ? {
          kind, id, multiple: el.multiple,
          options: [...el.options].map((o) => {
            const group = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null;
            return {
              label: o.label || o.text, value: o.value, selected: o.selected,
              disabled: o.disabled || (group ? group.disabled : false),
              group: group ? group.label : null,
            };
          }),
        }
      : { kind, id, value: el.value, min: el.min || null, max: el.max || null, step: el.step || null };
    globalThis.${PICKER_BINDING}(JSON.stringify(payload));
  };
  document.addEventListener("mousedown", (event) => {
    const el = targetOf(event);
    if (!el) return;
    event.preventDefault();
    open(el);
  }, true);
  // With touch emulated, a tap can reach a list without a mousedown first: the tap is taken at its
  // end, unless the finger moved (a scroll that started on the field).
  let touchStart = null;
  document.addEventListener("touchstart", (event) => {
    const t = event.touches[0];
    touchStart = targetOf(event) && t ? { x: t.clientX, y: t.clientY } : null;
  }, true);
  document.addEventListener("touchend", (event) => {
    const el = targetOf(event);
    const t = event.changedTouches[0];
    if (!el || !touchStart || !t) return;
    if (Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 10) return;
    event.preventDefault();
    open(el);
  }, { capture: true, passive: false });
  document.addEventListener("click", (event) => {
    if (targetOf(event)) event.preventDefault();
  }, true);
  document.addEventListener("keydown", (event) => {
    const el = targetOf(event);
    if (!el) return;
    if (event.key === " " || event.key === "Enter" || (event.altKey && event.key === "ArrowDown")) {
      event.preventDefault();
      open(el);
    }
  }, true);
})();`;

const COPY_EXPRESSION = `(() => {
  const el = document.activeElement;
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      typeof el.selectionStart === "number" && el.selectionEnd > el.selectionStart) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return String(getSelection() ?? "");
})()`;

function pickerReplyExpression(id: string, values: string[]): string {
  return `((id, values) => {
    const el = globalThis.__hakoPickers && globalThis.__hakoPickers.get(id);
    if (!el || !el.isConnected) return false;
    if (el instanceof HTMLSelectElement) {
      if (el.multiple) for (const o of el.options) o.selected = values.includes(o.value);
      else el.value = values[0] ?? el.value;
    } else {
      el.value = values[0] ?? "";
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })(${JSON.stringify(id)}, ${JSON.stringify(values)})`;
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

/** The editing command Chrome on a Mac needs spelled out for a dispatched Cmd shortcut. */
function macCommand(key: string, modifiers: number): string | null {
  if ((modifiers & 4) === 0) return null;
  const shift = (modifiers & 8) !== 0;
  switch (key.toLowerCase()) {
    case "a":
      return "selectAll";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "x":
      return "cut";
    case "z":
      return shift ? "redo" : "undo";
    default:
      return null;
  }
}

function virtualKeyCode(key: string): number {
  const known = KEY_CODES[key];
  if (known !== undefined) return known;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) return code;
  }
  return 0;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function clip(text: string): string {
  return text.length > BROWSER_CONSOLE_TEXT_MAX ? text.slice(0, BROWSER_CONSOLE_TEXT_MAX) : text;
}

/** The first history entry that counts: a tab's blank start page does not. */
function firstEntry(entries: { url: string }[]): number {
  return entries.length > 1 && entries[0].url === "about:blank" ? 1 : 0;
}

function readViewport(value: unknown): BrowserViewport {
  if (typeof value !== "object" || value === null) {
    throw new BrowserFailure("bad_request", "viewport is missing");
  }
  const v = value as Record<string, unknown>;
  const size = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 100 && n <= 4000;
  if (!size(v.width) || !size(v.height)) {
    throw new BrowserFailure("bad_request", "viewport width and height must be 100 to 4000");
  }
  const scale = typeof v.scale === "number" && Number.isFinite(v.scale) ? v.scale : NaN;
  if (!(scale >= SCALE_MIN && scale <= SCALE_MAX)) {
    throw new BrowserFailure("bad_request", "viewport scale must be 1 to 3");
  }
  return {
    width: Math.round(v.width as number),
    height: Math.round(v.height as number),
    scale,
    mobile: v.mobile === true,
    touch: v.touch === true,
    ...(typeof v.user_agent === "string" && v.user_agent !== ""
      ? { user_agent: v.user_agent }
      : {}),
  };
}

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

type Tab = {
  targetId: string;
  cdpSession: string;
  url: string;
  title: string;
  loading: boolean;
  openerId: string | null;
  consoleCount: number;
  /** The isolated world's execution context in the main frame. */
  worldContext: number | null;
  screencasting: boolean;
  requests: Map<string, string>;
};

type Session = {
  bid: number;
  tabs: Tab[];
  active: Tab | null;
  viewport: BrowserViewport;
  frameNumber: number;
  /** Frames sent and not acknowledged, by number: whose they are and Chrome's ack id. */
  unacked: Map<number, { tab: Tab; ackId: number; sentAt: number }>;
  stateTimer: ReturnType<typeof setTimeout> | null;
  dialogTab: Tab | null;
  pickers: Map<string, { tab: Tab; context: number; pickerId: string }>;
  choosers: Map<string, { tab: Tab; backendNodeId: number }>;
  /** Input is applied one batch after another, in the order it came. */
  inputs: Promise<void>;
  closed: boolean;
};

export function createBrowserMock(host: BrowserHost) {
  const chromePath = process.env.MOCK_BROWSER_CHROME ?? DEFAULT_CHROME;
  let chrome: ChildProcess | null = null;
  let profile: string | null = null;
  let cdp: Cdp | null = null;
  let launching: Promise<Cdp> | null = null;
  let userAgent: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextBid = 1;
  let nextId = 1;
  const sessions = new Map<number, Session>();
  /** Pages Chrome attached and paused, waiting to be claimed, by target id. */
  const waiting = new Map<string, { cdpSession: string; openerId: string | null }>();
  const claims = new Map<string, (cdpSession: string) => void>();
  const downloads = new Map<
    string,
    {
      session: Session;
      name: string;
      size: number;
      path: string;
      sentAt: number;
      cancelled: boolean;
    }
  >();

  const tabOf = (cdpSession: string | undefined) => {
    for (const session of sessions.values()) {
      for (const tab of session.tabs) {
        if (tab.cdpSession === cdpSession) return { session, tab };
      }
    }
    return null;
  };
  const tabById = (targetId: string) => {
    for (const session of sessions.values()) {
      for (const tab of session.tabs) if (tab.targetId === targetId) return { session, tab };
    }
    return null;
  };

  function sessionOf(params: Record<string, unknown>): Session {
    if (!isBid(params.bid)) throw new BrowserFailure("bad_request", "bid must be a number");
    const session = sessions.get(params.bid);
    if (!session) throw new BrowserFailure("not_found", "This browser session has ended");
    return session;
  }

  function activeTab(session: Session): Tab {
    if (!session.active) throw new BrowserFailure("not_found", "This browser session has no tab");
    return session.active;
  }

  function scheduleIdleStop(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (sessions.size > 0 || !chrome) return;
    idleTimer = setTimeout(() => {
      console.log("mock browser: no viewer for 15 minutes, stopping Chrome");
      stopChrome();
    }, IDLE_STOP_MS);
    idleTimer.unref();
  }

  function stopChrome(): void {
    cdp?.close();
    cdp = null;
    launching = null;
    chrome?.kill();
    chrome = null;
    if (profile) {
      const dir = profile;
      profile = null;
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500);
    }
  }

  async function launch(): Promise<Cdp> {
    if (!existsSync(chromePath)) {
      throw new BrowserFailure("failed", "Google Chrome is not installed on this Mac");
    }
    const port = await freePort();
    profile = mkdtempSync(join(tmpdir(), "hako-mock-chrome-"));
    mkdirSync(host.downloadsDir, { recursive: true });
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const child = chrome;
    child.once("exit", () => {
      if (chrome !== child) return;
      chrome = null;
      cdp = null;
      launching = null;
      for (const session of [...sessions.values()]) end(session, "Chrome quit on the Mac");
    });
    let endpoint: string | null = null;
    for (let tries = 0; tries < 100 && endpoint === null; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        endpoint = ((await response.json()) as { webSocketDebuggerUrl: string })
          .webSocketDebuggerUrl;
      } catch {
        // Not listening yet.
      }
    }
    if (endpoint === null) {
      stopChrome();
      throw new BrowserFailure("failed", "Chrome on the Mac did not start");
    }
    const connection = await Cdp.connect(endpoint);
    connection.onClose = () => {
      if (cdp === connection) cdp = null;
    };
    const version = await connection.send<{ userAgent: string }>("Browser.getVersion");
    // Headless Chrome names itself; the Mac's Chrome does not, and some sites care.
    userAgent = version.userAgent.replace("HeadlessChrome", "Chrome");
    listen(connection);
    await connection.send("Target.setDiscoverTargets", { discover: true });
    await connection.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }, { exclude: true }],
    });
    await connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: host.downloadsDir,
      eventsEnabled: true,
    });
    console.log(`mock browser: headless Chrome on port ${port}, profile ${profile}`);
    return connection;
  }

  async function browser(): Promise<Cdp> {
    if (cdp) return cdp;
    launching ??= launch().then(
      (connection) => {
        cdp = connection;
        return connection;
      },
      (error: unknown) => {
        launching = null;
        throw error;
      },
    );
    return launching;
  }

  function listen(connection: Cdp): void {
    connection.on("Target.attachedToTarget", (params) => {
      const info = params.targetInfo as { targetId: string; type: string; openerId?: string };
      const cdpSession = params.sessionId as string;
      if (process.env.MOCK_BROWSER_DEBUG) console.log(`attached ${JSON.stringify(params)}`);
      if (info.type !== "page") return;
      const claim = claims.get(info.targetId);
      if (claim) {
        claims.delete(info.targetId);
        claim(cdpSession);
        return;
      }
      const opener = info.openerId ? tabById(info.openerId) : null;
      if (opener) {
        adopt(opener.session, info.targetId, cdpSession, info.openerId ?? null, true).catch(
          (error: unknown) => console.error(`mock browser: a new tab: ${error}`),
        );
        return;
      }
      waiting.set(info.targetId, { cdpSession, openerId: info.openerId ?? null });
      // A page that is nobody's (Chrome's first blank tab) just runs.
      setTimeout(() => {
        if (!waiting.has(info.targetId)) return;
        waiting.delete(info.targetId);
        void connection.send("Runtime.runIfWaitingForDebugger", {}, cdpSession).catch(() => {});
      }, 2000);
    });
    connection.on("Target.targetInfoChanged", (params) => {
      const info = params.targetInfo as { targetId: string; url: string; title: string };
      const found = tabById(info.targetId);
      if (!found) return;
      found.tab.url = info.url;
      found.tab.title = info.title;
      scheduleState(found.session);
    });
    connection.on("Target.targetDestroyed", (params) => {
      const found = tabById(params.targetId as string);
      if (found) removeTab(found.session, found.tab);
    });
    connection.on("Target.detachedFromTarget", (params) => {
      const found = tabOf(params.sessionId as string);
      if (found) removeTab(found.session, found.tab);
    });
    connection.on("Page.screencastFrame", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      const ackId = params.sessionId as number;
      if (!found || found.session.active !== found.tab || found.session.closed) {
        void connection
          .send("Page.screencastFrameAck", { sessionId: ackId }, cdpSession)
          .catch(() => {});
        return;
      }
      const { session, tab } = found;
      const metadata = params.metadata as { deviceWidth: number; deviceHeight: number };
      const frame = ++session.frameNumber;
      session.unacked.set(frame, { tab, ackId, sentAt: Date.now() });
      host.sendBinary(
        encodeBrowserFrame(
          {
            bid: session.bid,
            frame,
            width: metadata.deviceWidth,
            height: metadata.deviceHeight,
            format: FRAME_JPEG,
          },
          Buffer.from(params.data as string, "base64"),
        ),
      );
    });
    connection.on("Page.frameStartedLoading", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || params.frameId !== found.tab.targetId) return;
      found.tab.loading = true;
      scheduleState(found.session);
    });
    connection.on("Page.frameStoppedLoading", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || params.frameId !== found.tab.targetId) return;
      found.tab.loading = false;
      scheduleState(found.session);
    });
    connection.on("Page.frameNavigated", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      const frame = params.frame as { id: string; parentId?: string; url: string };
      if (!found || frame.parentId) return;
      found.tab.url = frame.url;
      found.tab.consoleCount = 0;
      scheduleState(found.session);
    });
    connection.on("Page.navigatedWithinDocument", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || params.frameId !== found.tab.targetId) return;
      found.tab.url = params.url as string;
      scheduleState(found.session);
    });
    connection.on("Page.javascriptDialogOpening", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found) return;
      found.session.dialogTab = found.tab;
      // A dialog in a tab that is not shown brings that tab to the front, as a browser does.
      if (found.session.active !== found.tab) void activate(found.session, found.tab);
      host.sendEvent("browser.dialog", {
        bid: found.session.bid,
        tab: found.tab.targetId,
        kind: params.type,
        message: params.message ?? "",
        default: params.defaultPrompt ?? "",
      });
      // The lab's dialogs that go away by themselves: one whose page moves on, as a page does when
      // something else navigates it, and one answered on the Mac.
      const message = String(params.message ?? "");
      const tab = found.tab;
      if (message.includes("this page moves on")) {
        setTimeout(() => {
          void connection
            .send("Page.navigate", { url: new URL("/long", tab.url).href }, tab.cdpSession)
            .catch(() => {});
        }, 2000);
      } else if (message.includes("answered on the Mac")) {
        setTimeout(() => {
          void connection
            .send("Page.handleJavaScriptDialog", { accept: true }, tab.cdpSession)
            .catch(() => {});
        }, 2000);
      }
    });
    connection.on("Page.javascriptDialogClosed", (_params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found) return;
      if (found.session.dialogTab === found.tab) found.session.dialogTab = null;
      host.sendEvent("browser.dialog_closed", { bid: found.session.bid, tab: found.tab.targetId });
    });
    connection.on("Page.fileChooserOpened", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || typeof params.backendNodeId !== "number") return;
      const id = String(nextId++);
      found.session.choosers.set(id, { tab: found.tab, backendNodeId: params.backendNodeId });
      void (async () => {
        let accept = "";
        try {
          const { object } = await connection.send<{ object: { objectId: string } }>(
            "DOM.resolveNode",
            { backendNodeId: params.backendNodeId },
            cdpSession,
          );
          const { result } = await connection.send<{ result: { value: unknown } }>(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: "function () { return this.accept || ''; }",
              objectId: object.objectId,
              returnByValue: true,
            },
            cdpSession,
          );
          if (typeof result.value === "string") accept = result.value;
        } catch {
          // Without it the phone offers every kind of file.
        }
        host.sendEvent("browser.file_chooser", {
          bid: found.session.bid,
          id,
          multiple: params.mode === "selectMultiple",
          accept,
        });
      })();
    });
    connection.on("Runtime.executionContextCreated", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      const context = params.context as {
        id: number;
        name: string;
        auxData?: { frameId?: string; isDefault?: boolean };
      };
      if (
        found &&
        context.name === PICKER_WORLD &&
        context.auxData?.frameId === found.tab.targetId
      ) {
        found.tab.worldContext = context.id;
      }
    });
    connection.on("Runtime.bindingCalled", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || params.name !== PICKER_BINDING) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(params.payload as string);
      } catch {
        return;
      }
      const id = String(nextId++);
      found.session.pickers.set(id, {
        tab: found.tab,
        context: params.executionContextId as number,
        pickerId: String(payload.id),
      });
      host.sendEvent("browser.picker", { ...payload, id, bid: found.session.bid });
    });
    connection.on("Runtime.consoleAPICalled", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || !isLocalUrl(found.tab.url)) return;
      const levels: Record<string, string> = {
        error: "error",
        assert: "error",
        warning: "warn",
        info: "info",
        log: "log",
        debug: "debug",
      };
      const level = levels[params.type as string];
      if (!level) return;
      const args = (params.args ?? []) as { value?: unknown; description?: string }[];
      const text = args
        .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? "")))
        .join(" ");
      const frame = (params.stackTrace as { callFrames?: { url: string; lineNumber: number }[] })
        ?.callFrames?.[0];
      emitConsole(found.session, found.tab, {
        level,
        text,
        source: frame?.url || null,
        line: frame ? frame.lineNumber + 1 : null,
      });
    });
    connection.on("Runtime.exceptionThrown", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || !isLocalUrl(found.tab.url)) return;
      const details = params.exceptionDetails as {
        text: string;
        url?: string;
        lineNumber?: number;
        exception?: { description?: string };
      };
      emitConsole(found.session, found.tab, {
        level: "error",
        text: details.exception?.description ?? details.text,
        source: details.url || null,
        line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : null,
      });
    });
    connection.on("Network.requestWillBeSent", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found) return;
      const request = params.request as { url: string; method: string };
      if (found.tab.requests.size > 500) found.tab.requests.clear();
      found.tab.requests.set(params.requestId as string, `${request.method} ${request.url}`);
    });
    connection.on("Network.responseReceived", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      const response = params.response as { url: string; status: number; statusText: string };
      if (!found || response.status < 400 || !isLocalUrl(response.url)) return;
      const what = found.tab.requests.get(params.requestId as string) ?? response.url;
      emitConsole(found.session, found.tab, {
        level: "network",
        text: `${what} answered ${response.status} ${response.statusText}`.trim(),
        source: response.url,
        line: null,
        url: response.url,
        status: response.status,
      });
    });
    connection.on("Network.loadingFailed", (params, cdpSession) => {
      const found = tabOf(cdpSession);
      if (!found || params.canceled === true) return;
      const what = found.tab.requests.get(params.requestId as string);
      const url = what?.slice(what.indexOf(" ") + 1) ?? "";
      if (!isLocalUrl(url)) return;
      emitConsole(found.session, found.tab, {
        level: "network",
        text: `${what} failed: ${params.errorText}`,
        source: url,
        line: null,
        url,
        status: 0,
      });
    });
    connection.on("Browser.downloadWillBegin", (params) => {
      const found = tabById(params.frameId as string);
      const session = found?.session ?? [...sessions.values()].at(-1);
      if (!session) return;
      const name = String(params.suggestedFilename || "download");
      const guid = params.guid as string;
      const path = join(host.downloadsDir, guid);
      downloads.set(guid, { session, name, size: -1, path, sentAt: Date.now(), cancelled: false });
      host.sendEvent("browser.download", {
        bid: session.bid,
        path,
        name,
        size: -1,
        done: false,
        state: "progress",
      });
      // The lab's `cancel-me` download stands for one the owner cancels in Chrome on the Mac.
      if (name.startsWith("cancel-me")) {
        setTimeout(() => {
          const download = downloads.get(guid);
          if (!download) return;
          download.cancelled = true;
          void connection.send("Browser.cancelDownload", { guid }).catch(() => {});
        }, 2000);
      }
    });
    connection.on("Browser.downloadProgress", (params) => {
      const download = downloads.get(params.guid as string);
      if (!download) return;
      if (typeof params.totalBytes === "number" && params.totalBytes > 0) {
        download.size = params.totalBytes;
      }
      const ended = (state: "cancelled" | "failed", path = download.path) => {
        downloads.delete(params.guid as string);
        host.sendEvent("browser.download", {
          bid: download.session.bid,
          path,
          name: download.name,
          size: download.size,
          done: false,
          state,
        });
      };
      if (params.state === "canceled") {
        // Chrome says `canceled` for a transfer that broke too; only the one cancelled here is.
        ended(download.cancelled ? "cancelled" : "failed");
        return;
      }
      if (params.state === "inProgress") {
        if (Date.now() - download.sentAt < 1000) return;
        download.sentAt = Date.now();
        host.sendEvent("browser.download", {
          bid: download.session.bid,
          path: download.path,
          name: download.name,
          size: download.size,
          done: false,
          state: "progress",
        });
        return;
      }
      if (params.state !== "completed") return;
      downloads.delete(params.guid as string);
      // Chrome names the file by its guid; it is moved to its own name in a folder of its own.
      const directory = join(host.downloadsDir, `${params.guid}`.slice(0, 8));
      const path = join(directory, download.name);
      try {
        mkdirSync(directory, { recursive: true });
        renameSync(join(host.downloadsDir, params.guid as string), path);
      } catch (error) {
        console.error(`mock browser: download ${download.name}: ${error}`);
        ended("failed");
        return;
      }
      host.sendEvent("browser.download", {
        bid: download.session.bid,
        path,
        name: download.name,
        size: (params.receivedBytes as number) ?? download.size,
        done: true,
        state: "done",
      });
    });
  }

  function emitConsole(
    session: Session,
    tab: Tab,
    entry: { level: string; text: string; source: string | null; line: number | null } & Record<
      string,
      unknown
    >,
  ): void {
    if (tab.consoleCount >= BROWSER_CONSOLE_MAX) return;
    tab.consoleCount += 1;
    host.sendEvent("browser.console", { bid: session.bid, ...entry, text: clip(entry.text) });
  }

  async function emulate(tab: Tab, viewport: BrowserViewport): Promise<void> {
    const connection = await browser();
    const landscape = viewport.width > viewport.height;
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.scale,
        mobile: viewport.mobile,
        screenOrientation: landscape
          ? { type: "landscapePrimary", angle: 90 }
          : { type: "portraitPrimary", angle: 0 },
      },
      tab.cdpSession,
    );
    await connection.send(
      "Emulation.setTouchEmulationEnabled",
      viewport.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
      tab.cdpSession,
    );
    const agent = viewport.user_agent ?? userAgent;
    if (agent) {
      await connection.send("Emulation.setUserAgentOverride", { userAgent: agent }, tab.cdpSession);
    }
  }

  async function startScreencast(session: Session, tab: Tab): Promise<void> {
    const connection = await browser();
    if (tab.screencasting) await connection.send("Page.stopScreencast", {}, tab.cdpSession);
    tab.screencasting = true;
    await connection.send(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: 70,
        maxWidth: Math.round(session.viewport.width * session.viewport.scale),
        maxHeight: Math.round(session.viewport.height * session.viewport.scale),
        everyNthFrame: 1,
      },
      tab.cdpSession,
    );
  }

  async function stopScreencast(session: Session, tab: Tab): Promise<void> {
    if (!tab.screencasting) return;
    tab.screencasting = false;
    const connection = await browser();
    await connection.send("Page.stopScreencast", {}, tab.cdpSession).catch(() => {});
    // Frames of that tab that the phone has not acknowledged are let go, so Chrome is not left
    // waiting for them.
    for (const [frame, entry] of session.unacked) {
      if (entry.tab !== tab) continue;
      session.unacked.delete(frame);
      void connection
        .send("Page.screencastFrameAck", { sessionId: entry.ackId }, tab.cdpSession)
        .catch(() => {});
    }
  }

  async function adopt(
    session: Session,
    targetId: string,
    cdpSession: string,
    openerId: string | null,
    makeActive: boolean,
  ): Promise<Tab> {
    const connection = await browser();
    const tab: Tab = {
      targetId,
      cdpSession,
      url: "about:blank",
      title: "",
      loading: false,
      openerId,
      consoleCount: 0,
      worldContext: null,
      screencasting: false,
      requests: new Map(),
    };
    session.tabs.push(tab);
    const send = (method: string, params: object = {}) =>
      connection.send(method, params, cdpSession);
    // Sent together and answered in order: a pop-up that waits for the debugger may not answer
    // some of them until it runs, and it must not run before all of them are on their way.
    await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Network.enable"),
      send("Runtime.addBinding", { name: PICKER_BINDING, executionContextName: PICKER_WORLD }),
      send("Page.addScriptToEvaluateOnNewDocument", {
        source: PICKER_SCRIPT,
        worldName: PICKER_WORLD,
        runImmediately: true,
      }),
      send("Page.setInterceptFileChooserDialog", { enabled: true }),
      emulate(tab, session.viewport),
      send("Runtime.runIfWaitingForDebugger"),
    ]);
    if (makeActive) await activate(session, tab);
    scheduleState(session);
    return tab;
  }

  async function activate(session: Session, tab: Tab): Promise<void> {
    const previous = session.active;
    session.active = tab;
    if (previous && previous !== tab) await stopScreencast(session, previous);
    const connection = await browser();
    await connection.send("Page.bringToFront", {}, tab.cdpSession).catch(() => {});
    // Headless Chrome can lose a tab's emulated size while another tab is in front.
    await emulate(tab, session.viewport).catch(() => {});
    await startScreencast(session, tab);
    scheduleState(session);
  }

  function removeTab(session: Session, tab: Tab): void {
    const index = session.tabs.indexOf(tab);
    if (index === -1) return;
    session.tabs.splice(index, 1);
    for (const [frame, entry] of session.unacked)
      if (entry.tab === tab) session.unacked.delete(frame);
    if (session.closed) return;
    if (session.tabs.length === 0) {
      end(session, "Its last tab was closed");
      return;
    }
    if (session.active === tab) {
      const opener = session.tabs.find((other) => other.targetId === tab.openerId);
      void activate(session, opener ?? session.tabs[session.tabs.length - 1]);
    }
    scheduleState(session);
  }

  function end(session: Session, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.bid);
    if (session.stateTimer) clearTimeout(session.stateTimer);
    const connection = cdp;
    for (const tab of session.tabs) {
      void connection?.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
    }
    session.tabs = [];
    host.sendEvent("browser.closed", { bid: session.bid, reason });
    scheduleIdleStop();
  }

  function scheduleState(session: Session): void {
    if (session.stateTimer || session.closed) return;
    session.stateTimer = setTimeout(() => {
      session.stateTimer = null;
      void sendState(session);
    }, STATE_DELAY_MS);
  }

  async function sendState(session: Session): Promise<void> {
    const tab = session.active;
    if (!tab || session.closed) return;
    let canBack = false;
    let canForward = false;
    try {
      const connection = await browser();
      const history = await connection.send<{
        currentIndex: number;
        entries: { url: string }[];
      }>("Page.getNavigationHistory", {}, tab.cdpSession);
      canBack = history.currentIndex > firstEntry(history.entries);
      canForward = history.currentIndex < history.entries.length - 1;
      // Chrome does not always say when a title changes; it is read afresh each time.
      const { targetInfo } = await connection.send<{ targetInfo: { title: string; url: string } }>(
        "Target.getTargetInfo",
        { targetId: tab.targetId },
      );
      tab.title = targetInfo.title;
      tab.url = targetInfo.url;
    } catch {
      // A tab that is going away.
    }
    if (session.closed) return;
    host.sendEvent("browser.state", {
      bid: session.bid,
      tab: tab.targetId,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      can_back: canBack,
      can_forward: canForward,
      tabs: tabsOf(session),
    });
  }

  function tabsOf(session: Session): BrowserTab[] {
    return session.tabs.map((tab) => ({
      id: tab.targetId,
      url: tab.url,
      title: tab.title,
      active: tab === session.active,
    }));
  }

  /**
   * Opens a page of the session's own, set up (emulation, console, pickers) before it loads
   * anything: it starts blank, and that blank page does not count as a page to go back to.
   */
  async function newTab(session: Session, url: string): Promise<Tab> {
    const connection = await browser();
    // A window of its own: headless Chrome may not take input for a tab behind another one.
    const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const early = waiting.get(targetId);
    let cdpSession: string;
    if (early) {
      waiting.delete(targetId);
      cdpSession = early.cdpSession;
    } else {
      cdpSession = await new Promise<string>((resolve, reject) => {
        claims.set(targetId, resolve);
        setTimeout(() => {
          if (claims.delete(targetId))
            reject(new BrowserFailure("failed", "Chrome did not open a tab"));
        }, 10_000);
      });
    }
    const tab = await adopt(session, targetId, cdpSession, null, true);
    await connection.send("Page.navigate", { url }, cdpSession);
    return tab;
  }

  const unackedWatch = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      for (const entry of session.unacked.values()) {
        if (now - entry.sentAt > UNACKED_LIMIT_MS) {
          end(session, "No pictures were acknowledged for 5 minutes");
          break;
        }
      }
    }
  }, 30_000);
  unackedWatch.unref();

  async function input(session: Session, events: BrowserInputEvent[]): Promise<void> {
    const tab = session.active;
    if (!tab) return;
    const connection = await browser();
    // An event Chrome does not take within a few seconds is given up on, so one stuck event (in a
    // page that froze) does not hold back everything after it.
    const send = (method: string, params: object) =>
      Promise.race([
        connection.send(method, params, tab.cdpSession),
        new Promise((resolve) => setTimeout(resolve, INPUT_TIMEOUT_MS)),
      ]).catch((error: unknown) => {
        console.error(`mock browser: ${method}: ${error instanceof Error ? error.message : error}`);
      });
    for (const event of events) {
      switch (event.type) {
        case "touch": {
          const point = event.points[0];
          if (session.viewport.touch) {
            const type = {
              start: "touchStart",
              move: "touchMove",
              end: "touchEnd",
              cancel: "touchCancel",
            }[event.phase];
            const points =
              event.phase === "end" || event.phase === "cancel"
                ? []
                : event.points.map((p) => ({ x: p.x, y: p.y, id: p.id }));
            await send("Input.dispatchTouchEvent", { type, touchPoints: points });
          } else if (point) {
            if (event.phase === "start") {
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x,
                y: point.y,
              });
              await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 1,
                clickCount: 1,
              });
            } else if (event.phase === "move") {
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x,
                y: point.y,
                button: "left",
                buttons: 1,
              });
            } else {
              await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: point.x,
                y: point.y,
                button: "left",
                clickCount: 1,
              });
            }
          }
          break;
        }
        case "mouse": {
          const type = {
            move: "mouseMoved",
            down: "mousePressed",
            up: "mouseReleased",
            wheel: "mouseWheel",
          }[event.action];
          await send("Input.dispatchMouseEvent", {
            type,
            x: event.x,
            y: event.y,
            // A move names the button held during it, which is how a drag selects.
            button: event.action === "wheel" ? "none" : event.button,
            buttons: event.action === "move" && event.button === "left" ? 1 : 0,
            clickCount: event.clicks,
            deltaX: event.dx,
            deltaY: event.dy,
            modifiers: event.modifiers,
          });
          break;
        }
        case "scroll":
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            deltaX: event.dx,
            deltaY: event.dy,
          });
          break;
        case "text":
          if (event.text !== "") await send("Input.insertText", { text: event.text });
          break;
        case "key": {
          const code = virtualKeyCode(event.key);
          const plain = (event.modifiers & (2 | 4)) === 0;
          const text =
            event.key === "Enter"
              ? "\r"
              : plain && [...event.key].length === 1
                ? event.key
                : undefined;
          const command = macCommand(event.key, event.modifiers);
          const common = {
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode: code,
            modifiers: event.modifiers,
          };
          if (event.action !== "up") {
            await send("Input.dispatchKeyEvent", {
              ...common,
              type: text ? "keyDown" : "rawKeyDown",
              ...(text ? { text, unmodifiedText: text } : {}),
              ...(command ? { commands: [command] } : {}),
            });
          }
          if (event.action !== "down") {
            await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
          }
          break;
        }
      }
    }
  }

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    "browser.open": async (params) => {
      if (process.env.MOCK_BROWSER_DEBUG) console.log(`browser.open ${JSON.stringify(params)}`);
      let url: string | null = null;
      if (typeof params.preview_id === "string") {
        url = host.previewUrl(params.preview_id);
        if (url === null) throw new BrowserFailure("not_found", "No such preview");
        if (typeof params.url === "string" && params.url !== "") {
          url = new URL(params.url, url).href;
        }
      } else if (typeof params.url === "string") {
        url = normalizeAddress(params.url);
        if (url === null || params.url === "?") {
          throw new BrowserFailure("bad_request", "url is not an address");
        }
      }
      if (url === null) throw new BrowserFailure("bad_request", "Give a url or a preview_id");
      const viewport = readViewport(params.viewport);
      await browser();
      const session: Session = {
        bid: nextBid++,
        tabs: [],
        active: null,
        viewport,
        frameNumber: 0,
        unacked: new Map(),
        stateTimer: null,
        dialogTab: null,
        pickers: new Map(),
        choosers: new Map(),
        inputs: Promise.resolve(),
        closed: false,
      };
      sessions.set(session.bid, session);
      if (idleTimer) clearTimeout(idleTimer);
      await newTab(session, url);
      return { bid: session.bid, tabs: tabsOf(session) };
    },
    "browser.close": (params) => {
      if (process.env.MOCK_BROWSER_DEBUG) console.log(`browser.close ${JSON.stringify(params)}`);
      if (!isBid(params.bid)) throw new BrowserFailure("bad_request", "bid must be a number");
      const session = sessions.get(params.bid);
      if (session) end(session, "Closed");
      return {};
    },
    "browser.navigate": async (params) => {
      const session = sessionOf(params);
      const url = typeof params.url === "string" ? normalizeAddress(params.url) : null;
      if (url === null) throw new BrowserFailure("bad_request", "url is not an address");
      await (await browser()).send("Page.navigate", { url }, activeTab(session).cdpSession);
      return {};
    },
    "browser.back": (params) => history(sessionOf(params), -1),
    "browser.forward": (params) => history(sessionOf(params), 1),
    "browser.reload": async (params) => {
      const session = sessionOf(params);
      await (
        await browser()
      ).send("Page.reload", { ignoreCache: params.hard === true }, activeTab(session).cdpSession);
      return {};
    },
    "browser.stop_loading": async (params) => {
      const session = sessionOf(params);
      await (await browser()).send("Page.stopLoading", {}, activeTab(session).cdpSession);
      return {};
    },
    "browser.viewport": async (params) => {
      const session = sessionOf(params);
      session.viewport = readViewport(params.viewport);
      for (const tab of session.tabs) await emulate(tab, session.viewport);
      if (session.active) await startScreencast(session, session.active);
      return {};
    },
    "browser.switch_tab": async (params) => {
      const session = sessionOf(params);
      const tab = session.tabs.find((item) => item.targetId === params.tab);
      if (!tab) throw new BrowserFailure("not_found", "No such tab");
      await activate(session, tab);
      return {};
    },
    "browser.close_tab": async (params) => {
      const session = sessionOf(params);
      const tab = session.tabs.find((item) => item.targetId === params.tab);
      if (!tab) throw new BrowserFailure("not_found", "No such tab");
      await (await browser()).send("Target.closeTarget", { targetId: tab.targetId });
      return {};
    },
    "browser.dialog_reply": async (params) => {
      const session = sessionOf(params);
      const tab = session.dialogTab ?? activeTab(session);
      session.dialogTab = null;
      await (
        await browser()
      ).send(
        "Page.handleJavaScriptDialog",
        {
          accept: params.accept === true,
          ...(typeof params.text === "string" ? { promptText: params.text } : {}),
        },
        tab.cdpSession,
      );
      return {};
    },
    "browser.picker_reply": async (params) => {
      const session = sessionOf(params);
      const picker = typeof params.id === "string" ? session.pickers.get(params.id) : undefined;
      if (!picker) throw new BrowserFailure("not_found", "That picker is closed");
      if (!Array.isArray(params.values) || !params.values.every((v) => typeof v === "string")) {
        throw new BrowserFailure("bad_request", "values must be strings");
      }
      session.pickers.delete(params.id as string);
      await (
        await browser()
      ).send(
        "Runtime.evaluate",
        {
          expression: pickerReplyExpression(picker.pickerId, params.values as string[]),
          contextId: picker.context,
          userGesture: true,
        },
        picker.tab.cdpSession,
      );
      return {};
    },
    "browser.file_chooser_reply": async (params) => {
      const session = sessionOf(params);
      const chooser = typeof params.id === "string" ? session.choosers.get(params.id) : undefined;
      if (!chooser) throw new BrowserFailure("not_found", "That file chooser is closed");
      if (!Array.isArray(params.paths) || !params.paths.every((p) => typeof p === "string")) {
        throw new BrowserFailure("bad_request", "paths must be strings");
      }
      session.choosers.delete(params.id as string);
      if (params.paths.length > 0) {
        await (
          await browser()
        ).send(
          "DOM.setFileInputFiles",
          { files: params.paths, backendNodeId: chooser.backendNodeId },
          chooser.tab.cdpSession,
        );
      }
      return {};
    },
    "browser.copy": async (params) => {
      const session = sessionOf(params);
      const tab = activeTab(session);
      if (!isLocalUrl(tab.url) || tab.worldContext === null) {
        throw new BrowserFailure("failed", "Copying works on pages served from this Mac only");
      }
      const { result } = await (
        await browser()
      ).send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: COPY_EXPRESSION, contextId: tab.worldContext, returnByValue: true },
        tab.cdpSession,
      );
      return { text: typeof result.value === "string" ? result.value : "" };
    },
  };

  async function history(session: Session, step: -1 | 1): Promise<object> {
    const tab = activeTab(session);
    const connection = await browser();
    const { currentIndex, entries } = await connection.send<{
      currentIndex: number;
      entries: { id: number; url: string }[];
    }>("Page.getNavigationHistory", {}, tab.cdpSession);
    const entry = currentIndex + step >= firstEntry(entries) ? entries[currentIndex + step] : null;
    if (entry) {
      await connection.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.cdpSession);
    }
    return {};
  }

  return {
    methods,
    /** Notifications from the client. */
    notify(method: string, params: Record<string, unknown>): boolean {
      if (method === "browser.ack") {
        const session = isBid(params.bid) ? sessions.get(params.bid) : undefined;
        const frame = params.frame;
        if (!session || typeof frame !== "number") return true;
        const entry = session.unacked.get(frame);
        if (!entry) return true;
        session.unacked.delete(frame);
        void cdp
          ?.send("Page.screencastFrameAck", { sessionId: entry.ackId }, entry.tab.cdpSession)
          .catch(() => {});
        return true;
      }
      if (method === "browser.input") {
        const session = isBid(params.bid) ? sessions.get(params.bid) : undefined;
        if (session && Array.isArray(params.events)) {
          const events = params.events as BrowserInputEvent[];
          session.inputs = session.inputs.then(() => input(session, events));
        }
        return true;
      }
      return false;
    },
    /** The relay connection is gone, and with it every session. */
    dropAll(): void {
      for (const session of [...sessions.values()]) end(session, "The Mac disconnected");
    },
    dispose(): void {
      clearInterval(unackedWatch);
      for (const session of [...sessions.values()]) end(session, "The Mac quit");
      if (idleTimer) clearTimeout(idleTimer);
      stopChrome();
    },
  };
}
