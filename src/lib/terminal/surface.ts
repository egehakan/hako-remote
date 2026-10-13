// The drawn terminal: an xterm.js instance, sized either to mirror the Mac's terminal scaled to
// this screen, or to fill this screen at a readable font size.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { encodeWheel, type KeyModes } from "./keys";
import type { Size, TerminalSink } from "./session";
import type { TerminalLook } from "./theme";

export type SurfaceLayout =
  /** The Mac's columns and rows, with the font chosen so the full width fits, times `zoom`. */
  | { kind: "mac"; zoom: number }
  /** A fixed font size; the columns and rows that fit are offered to the Mac. */
  | { kind: "phone"; fontSize: number };

export type SurfaceOptions = {
  /** The scrolling box the terminal is panned in when it is larger than the screen. */
  scroller: HTMLElement;
  /** The element xterm draws into, inside the scroller. */
  host: HTMLElement;
  /** On a touch device xterm only draws; input comes from the app's own text field and key bar. */
  touch: boolean;
  look: TerminalLook;
  layout: SurfaceLayout;
  /** Keyboard and mouse input from xterm itself (not used on touch devices). */
  onData: (data: string) => void;
  /** Arrow keys for a full-screen program that is being scrolled by touch. */
  onScrollKeys: (key: "ArrowUp" | "ArrowDown", count: number) => void;
  /** Wheel notches, already encoded, for a full-screen program that reads the mouse. */
  onScrollWheel: (data: string) => void;
  /** Called when the size this screen could hold changes while the layout is "phone". */
  onPhoneSize: (size: Size) => void;
  /** Called when scrolling or output changes whether older output is hidden below the view. */
  onScrolledUp: (scrolledUp: boolean) => void;
};

const LINE_HEIGHT = 1.15;
const SCROLLBACK_LINES = 5_000;
const MIN_FONT_PX = 2;
const MAX_FONT_PX = 40;
/** What xterm keeps free for its scrollbar when it works out how many columns fit. */
const XTERM_SCROLLBAR_PX = 14;
const MAX_SCROLL_KEYS_PER_MOVE = 6;
const SGR_MOUSE_MODE = 1006;

/**
 * Keeps this terminal from answering the program's questions (device attributes, cursor position,
 * colours, focus). The terminal on the Mac answers them; a second answer from here would arrive as
 * stray input.
 */
function muteReplies(terminal: Terminal): void {
  const parser = terminal.parser;
  const swallow = () => true;
  parser.registerCsiHandler({ final: "c" }, swallow);
  parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow);
  parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow);
  parser.registerCsiHandler({ final: "n" }, swallow);
  parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow);
  parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow);
  parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow);
  parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow);
  parser.registerCsiHandler({ prefix: "?", final: "u" }, swallow);
  // Window reports are 11 to 21; the other window operations (title stack) stay with xterm.
  parser.registerCsiHandler({ final: "t" }, (params) => {
    const operation = params[0];
    return typeof operation === "number" && operation >= 11 && operation <= 21;
  });
  parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) => params.length === 1 && params[0] === 1004,
  );
  parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow);
  parser.registerDcsHandler({ intermediates: "+", final: "q" }, swallow);
  for (const ident of [4, 10, 11, 12]) {
    parser.registerOscHandler(ident, (data) => data.includes("?"));
  }
}

export class TerminalSurface implements TerminalSink {
  readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private readonly options: SurfaceOptions;
  private layoutMode: SurfaceLayout;
  private look: TerminalLook;
  private opened = false;
  private disposed = false;
  private scrolledUp = false;
  /** Whether the view keeps the cursor in sight as output arrives. Dragging the view turns it off. */
  private following = true;
  private pendingScroll = 0;
  /** Whether the program asked for mouse reports in the SGR form, which xterm does not tell. */
  private sgrMouse = false;
  private lastPhoneSize: Size | null = null;
  private revealQueued = false;
  private readonly observer: ResizeObserver;
  private layoutTimer: number | undefined;

  constructor(options: SurfaceOptions) {
    this.options = options;
    this.layoutMode = options.layout;
    this.look = options.look;
    this.terminal = new Terminal({
      cols: 80,
      rows: 24,
      fontFamily: options.look.fontFamily,
      fontSize: options.look.fontSize,
      lineHeight: LINE_HEIGHT,
      theme: options.look.colors,
      scrollback: SCROLLBACK_LINES,
      disableStdin: options.touch,
      cursorBlink: !options.touch,
      // xterm's own text field never has focus on a touch device, and a hollow cursor is hard to see.
      cursorInactiveStyle: options.touch ? "block" : "outline",
      macOptionClickForcesSelection: true,
    });
    muteReplies(this.terminal);
    this.watchMouseEncoding();
    this.terminal.loadAddon(this.fit);
    this.terminal.onData((data) => options.onData(data));
    this.terminal.onScroll(() => this.noteScroll());
    this.terminal.onWriteParsed(() => {
      this.noteScroll();
      if (this.following) this.queueReveal();
    });
    this.observer = new ResizeObserver(() => this.scheduleLayout());
    void this.open();
  }

  /** Follows mode 1006 as the program sets it. Every handler passes the sequence on to xterm. */
  private watchMouseEncoding(): void {
    const parser = this.terminal.parser;
    const note = (on: boolean) => (params: (number | number[])[]) => {
      if (params.includes(SGR_MOUSE_MODE)) this.sgrMouse = on;
      return false;
    };
    parser.registerCsiHandler({ prefix: "?", final: "h" }, note(true));
    parser.registerCsiHandler({ prefix: "?", final: "l" }, note(false));
    parser.registerEscHandler({ final: "c" }, () => {
      this.sgrMouse = false;
      return false;
    });
  }

  /** Waits for the web font, so the first measurement is of the font that will be drawn. */
  private async open(): Promise<void> {
    const font = `${this.look.fontSize}px ${this.look.fontFamily}`;
    await Promise.race([
      Promise.all([document.fonts.load(font), document.fonts.load(`bold ${font}`)]).catch(() => {}),
      new Promise((resolve) => window.setTimeout(resolve, 1_500)),
    ]);
    if (this.disposed) return;
    this.terminal.open(this.options.host);
    if (this.options.touch && this.terminal.textarea) {
      this.terminal.textarea.tabIndex = -1;
      this.terminal.textarea.setAttribute("aria-hidden", "true");
    }
    this.opened = true;
    // With a hardware keyboard the terminal is ready to type into as soon as it opens.
    if (!this.options.touch) this.terminal.focus();
    this.observer.observe(this.options.scroller);
    this.layout();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    window.clearTimeout(this.layoutTimer);
    this.terminal.dispose();
  }

  // The session writes through these. xterm parses asynchronously but in order, so a resize that
  // must happen between two pieces of output is queued behind the first.

  replace(cols: number, rows: number, bytes: Uint8Array): void {
    // CAN ends an escape sequence the lost bytes may have left open; RIS resets everything else.
    this.terminal.write("\x18\x1bc", () => this.applySize(cols, rows));
    this.terminal.write(bytes, () => {
      this.following = true;
      this.terminal.scrollToBottom();
      this.queueReveal();
    });
  }

  write(bytes: Uint8Array): void {
    this.terminal.write(bytes);
  }

  resize(cols: number, rows: number): void {
    this.terminal.write("", () => this.applySize(cols, rows));
  }

  private applySize(cols: number, rows: number): void {
    if (this.disposed || cols < 2 || rows < 1) return;
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.terminal.resize(cols, rows);
      this.layout();
    }
  }

  // Layout

  setLook(look: TerminalLook): void {
    this.look = look;
    this.terminal.options.theme = look.colors;
    this.terminal.options.fontFamily = look.fontFamily;
    this.layout();
  }

  setLayout(layout: SurfaceLayout): void {
    this.layoutMode = layout;
    this.lastPhoneSize = null;
    this.layout();
  }

  /**
   * Changes the layout while the point at `x`, `y` of the box (where two fingers pinched) keeps
   * showing the same text.
   */
  zoomAround(layout: SurfaceLayout, x: number, y: number): void {
    const { scroller } = this.options;
    const before = this.fontSize;
    const contentX = scroller.scrollLeft + x;
    const contentY = scroller.scrollTop + y;
    this.following = false;
    this.setLayout(layout);
    const ratio = this.fontSize / before;
    scroller.scrollLeft = contentX * ratio - x;
    scroller.scrollTop = contentY * ratio - y;
  }

  /** The font size on screen, in CSS pixels. */
  get fontSize(): number {
    return this.terminal.options.fontSize ?? this.look.fontSize;
  }

  private get screen(): HTMLElement | null {
    return this.terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  }

  /** One character cell in CSS pixels. */
  cell(): { width: number; height: number } {
    const screen = this.screen;
    if (!screen) return { width: 0, height: 0 };
    return {
      width: screen.offsetWidth / this.terminal.cols,
      height: screen.offsetHeight / this.terminal.rows,
    };
  }

  private scheduleLayout(): void {
    window.clearTimeout(this.layoutTimer);
    // Rotation and the on-screen keyboard resize the box many times in a row.
    this.layoutTimer = window.setTimeout(() => this.layout(), 80);
  }

  private setFontSize(size: number): void {
    const next = Math.round(Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, size)) * 100) / 100;
    if (next !== this.terminal.options.fontSize) this.terminal.options.fontSize = next;
  }

  layout(): void {
    const { scroller, host } = this.options;
    const screen = this.screen;
    if (!this.opened || this.disposed || !screen) return;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    if (width === 0 || height === 0) return;

    if (this.layoutMode.kind === "mac") {
      // Cell width grows with the font size, so one measurement gives the size that fits; the
      // loop only corrects the rounding.
      const perPixel = screen.offsetWidth / this.fontSize;
      if (perPixel > 0) this.setFontSize((width / perPixel) * this.layoutMode.zoom);
      const allowed = width * this.layoutMode.zoom + 0.5;
      for (let tries = 0; tries < 6 && screen.offsetWidth > allowed; tries += 1) {
        this.setFontSize(this.fontSize * Math.min(0.995, allowed / screen.offsetWidth));
      }
    } else {
      this.setFontSize(this.layoutMode.fontSize);
      // The fit addon measures the terminal's parent, so the host takes the size of the box for a
      // moment. On a touch device there is no scrollbar to keep room for.
      host.style.width = `${width + (this.options.touch ? XTERM_SCROLLBAR_PX : 0)}px`;
      host.style.height = `${height}px`;
      const proposed = this.fit.proposeDimensions();
      if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) {
        const size = { cols: proposed.cols, rows: proposed.rows };
        if (size.cols !== this.lastPhoneSize?.cols || size.rows !== this.lastPhoneSize.rows) {
          this.lastPhoneSize = size;
          this.options.onPhoneSize(size);
        }
      }
    }
    host.style.width = `${screen.offsetWidth}px`;
    host.style.height = `${screen.offsetHeight}px`;
    this.revealCursor();
  }

  // Scrolling

  get keyModes(): KeyModes {
    return { applicationCursor: this.terminal.modes.applicationCursorKeysMode };
  }

  get bracketedPaste(): boolean {
    return this.terminal.modes.bracketedPasteMode;
  }

  private noteScroll(): void {
    const buffer = this.terminal.buffer.active;
    const scrolledUp = buffer.viewportY < buffer.baseY;
    if (scrolledUp === this.scrolledUp) return;
    this.scrolledUp = scrolledUp;
    this.options.onScrolledUp(scrolledUp);
  }

  /**
   * Moves the view by a finger's travel in CSS pixels: `dy` above zero shows older output. Panning
   * the oversized terminal and scrolling its history behave as one long page; a full-screen program
   * has no history, so it gets wheel notches if it reads the mouse and arrow keys if it does not.
   */
  scrollBy(dx: number, dy: number): void {
    const { scroller } = this.options;
    if (dx !== 0) scroller.scrollLeft -= dx;
    if (dy === 0) return;
    this.following = false;
    const buffer = this.terminal.buffer.active;
    if (dy > 0) {
      const pan = Math.min(dy, scroller.scrollTop);
      scroller.scrollTop -= pan;
      this.scrollLines(-(dy - pan));
    } else if (buffer.viewportY < buffer.baseY) {
      this.scrollLines(-dy);
    } else {
      const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      const pan = Math.min(-dy, Math.max(0, room));
      scroller.scrollTop += pan;
      if (buffer.type === "alternate") this.scrollLines(-dy - pan);
    }
  }

  /** True while a full-screen program has the terminal, where a flick must not coast. */
  get alternateScreen(): boolean {
    return this.terminal.buffer.active.type === "alternate";
  }

  /** True while the program wants the wheel reported, in the one form this app sends it in. */
  private get takesWheel(): boolean {
    const tracking = this.terminal.modes.mouseTrackingMode;
    return this.sgrMouse && tracking !== "none" && tracking !== "x10";
  }

  /** Scrolls the history by a distance in pixels, keeping the part of a line for the next call. */
  private scrollLines(pixels: number): void {
    const height = this.cell().height;
    if (height <= 0 || pixels === 0) return;
    this.pendingScroll += pixels;
    const lines = Math.trunc(this.pendingScroll / height);
    if (lines === 0) return;
    this.pendingScroll -= lines * height;
    if (this.terminal.buffer.active.type === "alternate") {
      const count = Math.min(Math.abs(lines), MAX_SCROLL_KEYS_PER_MOVE);
      if (this.takesWheel) {
        const column = Math.ceil(this.terminal.cols / 2);
        const row = Math.ceil(this.terminal.rows / 2);
        const notch = encodeWheel(lines < 0 ? "up" : "down", column, row);
        this.options.onScrollWheel(notch.repeat(count));
      } else {
        this.options.onScrollKeys(lines < 0 ? "ArrowUp" : "ArrowDown", count);
      }
    } else {
      this.terminal.scrollLines(lines);
    }
  }

  /** Back to the newest output, with the cursor in sight. Called for every key sent. */
  follow(): void {
    this.following = true;
    this.pendingScroll = 0;
    if (this.scrolledUp) this.terminal.scrollToBottom();
    this.queueReveal();
  }

  private queueReveal(): void {
    if (this.revealQueued) return;
    this.revealQueued = true;
    requestAnimationFrame(() => {
      this.revealQueued = false;
      if (!this.disposed && this.following) this.revealCursor();
    });
  }

  /** Pans a terminal that is larger than its box so that the cursor is inside the box. */
  private revealCursor(): void {
    const { scroller } = this.options;
    const cell = this.cell();
    const buffer = this.terminal.buffer.active;
    if (!this.following || cell.height === 0 || buffer.viewportY < buffer.baseY) return;
    const top = buffer.cursorY * cell.height;
    const bottom = top + cell.height;
    if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    } else if (top < scroller.scrollTop) {
      scroller.scrollTop = top;
    }
    // Sideways the cursor gets some room, so the text being typed is readable around it.
    const margin = Math.min(scroller.clientWidth / 4, cell.width * 12);
    const left = buffer.cursorX * cell.width;
    if (left + cell.width + margin > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = left + cell.width + margin - scroller.clientWidth;
    } else if (left - margin < scroller.scrollLeft) {
      scroller.scrollLeft = Math.max(0, left - margin);
    }
  }

  /** The history and the screen as plain text, with wrapped lines joined again. */
  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (!line) continue;
      // A line that continues on the next one keeps its trailing spaces: they are part of the text.
      const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}
