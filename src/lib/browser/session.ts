// One viewer session of the Mac browser: opens it, draws its pictures, sends input, and follows what
// the Mac says about it (docs/protocol.md, "Mac browser"). A session the relay closed because this
// client's connection dropped is opened again by itself, at the address it was at.

import type {
  BrowserConsole,
  BrowserDialog,
  BrowserDownload,
  BrowserFileChooser,
  BrowserFrame,
  BrowserInputEvent,
  BrowserOpenResult,
  BrowserPicker,
  BrowserState,
  BrowserViewport,
} from "@shared/browser";
import { relay, RpcFailure } from "@/lib/connection";
import { type DownloadItem, markStalled, mergeDownload, nextStallAt } from "./downloads";
import { FramePipeline } from "./frames";

export type BrowserTarget = { previewId: string } | { url: string };

export type SessionPhase =
  /** Asking the Mac for a session; Chrome may be starting there. */
  | "starting"
  | "live"
  /** The Mac or the relay is out of reach; the session is opened again when they are back. */
  | "waiting"
  /** The Mac ended the session (or never had it): it waits for Reopen. */
  | "ended"
  | "failed"
  | "no-chrome"
  /** The Hako on the Mac has no Mac browser. */
  | "unsupported";

export type ConsoleItem = BrowserConsole & { id: number; at: number };
export type { DownloadItem };

export type SessionSnapshot = {
  phase: SessionPhase;
  message: string | null;
  bid: number | null;
  state: BrowserState | null;
  /** The CSS size of the picture on screen, null before the first one. */
  picture: { width: number; height: number } | null;
  dialog: BrowserDialog | null;
  picker: BrowserPicker | null;
  chooser: BrowserFileChooser | null;
  downloads: DownloadItem[];
  console: ConsoleItem[];
};

const OPEN_TIMEOUT_MS = 60_000;
const SESSION_METHODS = new Set([
  "browser.navigate",
  "browser.back",
  "browser.forward",
  "browser.reload",
  "browser.stop_loading",
  "browser.viewport",
]);
const CONSOLE_KEPT = 300;
const NO_CHROME = /chrome/i;
const NOT_THERE = /not (?:be )?(?:installed|found)/i;

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

/** The sentence for the owner from a failed request, or a fallback. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof RpcFailure && error.message ? error.message : fallback;
}

export class MacBrowserSession {
  private snapshot: SessionSnapshot = {
    phase: "starting",
    message: null,
    bid: null,
    state: null,
    picture: null,
    dialog: null,
    picker: null,
    chooser: null,
    downloads: [],
    console: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly target: BrowserTarget;
  private viewport: BrowserViewport;
  private canvas: HTMLCanvasElement | null = null;
  private readonly pipeline: FramePipeline<ImageBitmap>;
  private queue: BrowserInputEvent[] = [];
  private flushScheduled = false;
  private opening = 0;
  private stops: (() => void)[] = [];
  private disposed = false;
  private nextItem = 1;
  /** Where the session was when it was lost, to open it there again. */
  private lastUrl: string | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(target: BrowserTarget, viewport: BrowserViewport) {
    this.target = target;
    this.viewport = viewport;
    this.pipeline = new FramePipeline<ImageBitmap>({
      decode: (frame) =>
        createImageBitmap(
          new Blob([frame.image as BlobPart], {
            type: frame.format === 2 ? "image/png" : "image/jpeg",
          }),
        ),
      draw: (bitmap, frame) => this.draw(bitmap, frame),
      release: (bitmap) => bitmap.close(),
      ack: (bid, frame) => {
        if (bid === this.snapshot.bid) relay.notify("browser.ack", { bid, frame });
      },
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  start(): void {
    const mine = (data: unknown) => {
      const bid = (data as { bid?: unknown } | null)?.bid;
      return bid !== undefined && bid === this.snapshot.bid;
    };
    this.stops = [
      relay.onBrowserFrame((frame) => {
        if (frame.bid === this.snapshot.bid) this.pipeline.push(frame);
      }),
      relay.on("browser.state", (data) => {
        if (!mine(data)) return;
        const state = data as BrowserState;
        if (state.url) this.lastUrl = state.url;
        this.set({ state });
      }),
      relay.on("browser.dialog", (data) => {
        if (mine(data)) this.set({ dialog: data as BrowserDialog });
      }),
      relay.on("browser.picker", (data) => {
        if (mine(data)) this.set({ picker: data as BrowserPicker });
      }),
      relay.on("browser.file_chooser", (data) => {
        if (mine(data)) this.set({ chooser: data as BrowserFileChooser });
      }),
      relay.on("browser.download", (data) => {
        if (mine(data)) this.addDownload(data as BrowserDownload);
      }),
      relay.on("browser.console", (data) => {
        if (!mine(data)) return;
        const item: ConsoleItem = {
          ...(data as BrowserConsole),
          id: this.nextItem++,
          at: Date.now(),
        };
        this.set({ console: [...this.snapshot.console, item].slice(-CONSOLE_KEPT) });
      }),
      relay.on("browser.closed", (data) => {
        if (!mine(data)) return;
        const reason = (data as { reason?: unknown }).reason;
        this.lose("ended", typeof reason === "string" ? reason : null);
      }),
      relay.subscribe(() => this.onLink()),
    ];
    // A page that is left without being closed (a reload, the back/forward cache) ends its
    // session itself, in case its connection stays open for a while.
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.stops.push(() => {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
    });
    void this.open();
  }

  private readonly onPageHide = (): void => {
    const bid = this.snapshot.bid;
    if (bid === null) return;
    void relay.request("browser.close", { bid }).catch(() => {});
    this.lose("waiting", null);
  };

  private readonly onPageShow = (): void => this.onLink();

  dispose(): void {
    this.disposed = true;
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    for (const stop of this.stops) stop();
    this.stops = [];
    this.pipeline.reset();
    const bid = this.snapshot.bid;
    if (bid !== null) void relay.request("browser.close", { bid }).catch(() => {});
    this.listeners.clear();
  }

  setCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  /** Opens the session again after it ended, at the address it was at. */
  reopen(): void {
    void this.open();
  }

  setViewport(viewport: BrowserViewport): void {
    const same =
      viewport.width === this.viewport.width &&
      viewport.height === this.viewport.height &&
      viewport.scale === this.viewport.scale &&
      viewport.mobile === this.viewport.mobile &&
      viewport.touch === this.viewport.touch;
    this.viewport = viewport;
    const bid = this.snapshot.bid;
    if (same || bid === null || this.snapshot.phase !== "live") return;
    void this.call("browser.viewport", { viewport }).catch(() => {});
  }

  navigate(url: string): Promise<void> {
    return this.call("browser.navigate", { url });
  }
  back(): Promise<void> {
    return this.call("browser.back");
  }
  forward(): Promise<void> {
    return this.call("browser.forward");
  }
  reload(hard = false): Promise<void> {
    return this.call("browser.reload", { hard });
  }
  stopLoading(): Promise<void> {
    return this.call("browser.stop_loading");
  }
  switchTab(tab: string): Promise<void> {
    return this.call("browser.switch_tab", { tab });
  }
  closeTab(tab: string): Promise<void> {
    return this.call("browser.close_tab", { tab });
  }

  replyDialog(accept: boolean, text: string): void {
    this.set({ dialog: null });
    void this.call("browser.dialog_reply", { accept, text }).catch(() => {});
  }

  /** The owner's choice in a picker, or null when it was closed without one (nothing is sent). */
  replyPicker(values: string[] | null): void {
    const picker = this.snapshot.picker;
    this.set({ picker: null });
    if (picker && values !== null) {
      void this.call("browser.picker_reply", { id: picker.id, values }).catch(() => {});
    }
  }

  replyChooser(paths: string[]): void {
    const chooser = this.snapshot.chooser;
    this.set({ chooser: null });
    if (chooser) {
      void this.call("browser.file_chooser_reply", { id: chooser.id, paths }).catch(() => {});
    }
  }

  dismissDownload(id: number): void {
    this.setDownloads(this.snapshot.downloads.filter((item) => item.id !== id));
  }

  clearConsole(): void {
    this.set({ console: [] });
  }

  /** The page's selected text. */
  async copy(): Promise<string> {
    const bid = this.snapshot.bid;
    if (bid === null) throw new RpcFailure("disconnected", "The browser is not open");
    const result = await relay.request<{ text: string }>("browser.copy", { bid });
    return typeof result?.text === "string" ? result.text : "";
  }

  /**
   * Queues input. Events go out together once per animation frame, in order, and a run of mouse
   * moves is cut to its last, so a fast mouse does not flood the link.
   */
  input(...events: BrowserInputEvent[]): void {
    if (this.snapshot.phase !== "live") return;
    for (const event of events) {
      const last = this.queue[this.queue.length - 1];
      if (
        event.type === "mouse" &&
        event.action === "move" &&
        last?.type === "mouse" &&
        last.action === "move" &&
        last.button === event.button
      ) {
        this.queue[this.queue.length - 1] = event;
      } else {
        this.queue.push(event);
      }
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => this.flush());
  }

  /** Sends what is queued now, for keys, which should not wait for the next frame. */
  flush(): void {
    this.flushScheduled = false;
    const bid = this.snapshot.bid;
    if (this.queue.length === 0 || bid === null) {
      this.queue = [];
      return;
    }
    relay.notify("browser.input", { bid, events: this.queue });
    this.queue = [];
  }

  private async open(): Promise<void> {
    if (this.disposed) return;
    const attempt = ++this.opening;
    this.pipeline.reset();
    this.set({
      phase: isUp() ? "starting" : "waiting",
      message: null,
      bid: null,
      dialog: null,
      picker: null,
      chooser: null,
    });
    if (!isUp()) return;
    const where =
      this.lastUrl !== null
        ? { url: this.lastUrl }
        : "previewId" in this.target
          ? { preview_id: this.target.previewId }
          : { url: this.target.url };
    try {
      const result = await relay.request<BrowserOpenResult>(
        "browser.open",
        { ...where, viewport: this.viewport },
        OPEN_TIMEOUT_MS,
      );
      if (attempt !== this.opening || this.disposed) {
        void relay.request("browser.close", { bid: result.bid }).catch(() => {});
        return;
      }
      const active = result.tabs.find((tab) => tab.active) ?? result.tabs[0];
      this.set({
        phase: "live",
        bid: result.bid,
        state: active
          ? {
              bid: result.bid,
              tab: active.id,
              url: active.url,
              title: active.title,
              loading: true,
              can_back: false,
              can_forward: false,
              tabs: result.tabs,
            }
          : this.snapshot.state,
      });
    } catch (error) {
      if (attempt !== this.opening || this.disposed) return;
      if (!(error instanceof RpcFailure)) {
        this.set({ phase: "failed", message: "Couldn’t open the browser on your Mac." });
        return;
      }
      switch (error.code) {
        case "not_supported":
          this.set({ phase: "unsupported" });
          return;
        case "agent_offline":
        case "disconnected":
          this.set({ phase: "waiting" });
          return;
        case "not_found":
          this.set({ phase: "ended", message: error.message || null });
          return;
        default:
          if (NO_CHROME.test(error.message) && NOT_THERE.test(error.message)) {
            this.set({ phase: "no-chrome", message: error.message });
          } else {
            this.set({
              phase: "failed",
              message: messageOf(error, "Couldn’t open the browser on your Mac."),
            });
          }
      }
    }
  }

  /** The session is gone: drawn no more, and opened again by itself only when it was `waiting`. */
  private lose(phase: "ended" | "waiting", message: string | null): void {
    this.pipeline.reset();
    this.opening += 1;
    this.queue = [];
    this.set({ phase, message, bid: null, dialog: null, picker: null, chooser: null });
  }

  private onLink(): void {
    const phase = this.snapshot.phase;
    if (!isUp()) {
      // The relay closes this client's sessions when its connection drops, and the Mac's end with
      // the Mac's connection; either way this one is gone.
      if (phase === "live" || phase === "starting") this.lose("waiting", null);
      return;
    }
    if (phase === "waiting") void this.open();
  }

  private async call(method: string, params: object = {}): Promise<void> {
    const bid = this.snapshot.bid;
    if (bid === null) return;
    try {
      await relay.request(method, { bid, ...params });
    } catch (error) {
      // For a method that names nothing but the session, `not_found` means the Mac no longer has
      // it; for the others it may be a tab, a picker or a file chooser that has gone.
      if (
        error instanceof RpcFailure &&
        error.code === "not_found" &&
        bid === this.snapshot.bid &&
        SESSION_METHODS.has(method)
      ) {
        this.lose("ended", null);
      }
      throw error;
    }
  }

  private draw(bitmap: ImageBitmap, frame: BrowserFrame): void {
    const canvas = this.canvas;
    if (!canvas) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const picture = this.snapshot.picture;
    if (!picture || picture.width !== frame.width || picture.height !== frame.height) {
      this.set({ picture: { width: frame.width, height: frame.height } });
    }
  }

  private addDownload(download: BrowserDownload): void {
    this.setDownloads(
      mergeDownload(this.snapshot.downloads, download, this.nextItem++, Date.now()),
    );
  }

  /** Sets the list, and wakes up when the next unfinished download is due to be given up on. */
  private setDownloads(downloads: DownloadItem[]): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.set({ downloads });
    const due = nextStallAt(downloads);
    if (due === null || this.disposed) return;
    this.stallTimer = setTimeout(
      () => this.setDownloads(markStalled(this.snapshot.downloads, Date.now())),
      Math.max(0, due - Date.now()) + 50,
    );
  }

  private set(change: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
