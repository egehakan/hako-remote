// Everything one open terminal consists of on this side: the session, the drawn surface, and the
// ways input reaches the Mac.

import { encodeKey, encodeKeyEvent, encodePaste, encodeText, type KeyEventLike } from "./keys";
import {
  activeSticky,
  consumeSticky,
  lockSticky,
  NO_STICKY,
  type StickyKey,
  type StickyState,
  tapSticky,
} from "./modifiers";
import { fileUrlPath, findPaths } from "./links";
import {
  findTarget,
  knownTarget,
  prepareForPaths,
  openPath,
  type PathTarget,
  targetsAt,
  webLink,
} from "./path-taps";
import { TerminalSession } from "./session";
import { type BufferCell, type SurfaceLayout, TerminalSurface } from "./surface";
import type { TerminalLook } from "./theme";

export type ControllerState = {
  sticky: StickyState;
  /** True while older output is shown and the newest is out of sight. */
  scrolledUp: boolean;
  /** The cells of a tapped path while the Mac is asked whether it is there. */
  checking: BufferCell[] | null;
};

/** What a tap did: "keyboard" leaves it to the caller to raise the keyboard, as before paths. */
export type TapResult = "keyboard" | "handled";

export type ControllerOptions = {
  sessionId: string;
  scroller: HTMLElement;
  host: HTMLElement;
  touch: boolean;
  look: TerminalLook;
  layout: SurfaceLayout;
};

/**
 * A program that reads a paste and the Enter after it in one go may take the Enter for part of the
 * paste, so the Enter of a sent message follows a moment later.
 */
const ENTER_DELAY_MS = 80;
/** A program that attaches a pasted picture reads the file first, which takes it a little longer. */
const ENTER_AFTER_ATTACHMENT_MS = 300;

export class TerminalController {
  readonly session: TerminalSession;
  readonly surface: TerminalSurface;
  private state: ControllerState = { sticky: NO_STICKY, scrolledUp: false, checking: null };
  /** Goes up with every tap, so that only the last one acts when the Mac answers. */
  private tapCount = 0;
  /** The terminal's working directory, which relative paths are read against. */
  cwd: string | null = null;
  private readonly listeners = new Set<() => void>();
  /** True while the Mac's terminal is resized to this screen (the "phone" layout). */
  private fitPhone: boolean;
  private enterTimer: number | undefined;

  constructor(options: ControllerOptions) {
    this.fitPhone = options.layout.kind === "phone";
    this.surface = new TerminalSurface({
      scroller: options.scroller,
      host: options.host,
      touch: options.touch,
      look: options.look,
      layout: options.layout,
      onData: (data) => {
        // A modifier armed on the key bar also applies to a character typed on a real keyboard.
        if ([...data].length === 1 && this.state.sticky !== NO_STICKY) this.type(data);
        else this.send(data);
      },
      onScrollKeys: (key, count) => {
        const data = encodeKey(
          key,
          { ctrl: false, alt: false, shift: false },
          this.surface.keyModes,
        );
        if (data !== null) this.session.send(data.repeat(count));
      },
      onScrollWheel: (data) => this.session.send(data),
      onMouse: (data) => this.session.send(data),
      onLink: (uri) => this.openLink(uri),
      onPhoneSize: (size) => {
        if (this.fitPhone) this.session.setFit(size);
      },
      onScrolledUp: (scrolledUp) => this.set({ scrolledUp }),
    });
    this.session = new TerminalSession(options.sessionId, this.surface);
    if (!options.touch) this.providePathLinks();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ControllerState => this.state;

  start(): void {
    this.session.start();
    prepareForPaths();
  }

  dispose(): void {
    window.clearTimeout(this.enterTimer);
    this.session.stop();
    this.surface.dispose();
  }

  /** Switches between mirroring the Mac's size and resizing the Mac's terminal to this screen. */
  setLayout(layout: SurfaceLayout): void {
    this.fitPhone = layout.kind === "phone";
    if (!this.fitPhone) this.session.setFit(null);
    this.surface.setLayout(layout);
  }

  /** The same for a pinch, which zooms around the point between the fingers. */
  zoomAround(layout: SurfaceLayout, x: number, y: number): void {
    this.fitPhone = layout.kind === "phone";
    this.surface.zoomAround(layout, x, y);
  }

  // Input

  private send(data: string): void {
    this.session.send(data);
    this.surface.follow();
  }

  private useSticky(): { ctrl: boolean; alt: boolean } {
    const active = activeSticky(this.state.sticky);
    this.set({ sticky: consumeSticky(this.state.sticky) });
    return active;
  }

  /** A key of the key bar, by its `KeyboardEvent.key` name or as a single character. */
  press(key: string, held: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): void {
    const sticky = this.useSticky();
    const data = encodeKey(
      key,
      {
        ctrl: sticky.ctrl || held.ctrl === true,
        alt: sticky.alt || held.alt === true,
        shift: held.shift === true,
      },
      this.surface.keyModes,
    );
    if (data !== null) this.send(data);
  }

  /** Text from the on-screen keyboard. A sticky modifier applies to its first character. */
  type(text: string): void {
    if (text === "") return;
    this.send(encodeText(text, { ...this.useSticky(), shift: false }, this.surface.keyModes));
  }

  erase(count: number): void {
    if (count > 0) this.send("\x7f".repeat(count));
  }

  /** A key of a hardware keyboard. Returns true when it was sent and the browser should stop. */
  keyEvent(event: KeyEventLike): boolean {
    const data = encodeKeyEvent(event, activeSticky(this.state.sticky), this.surface.keyModes);
    if (data === null) return false;
    this.useSticky();
    this.send(data);
    return true;
  }

  paste(text: string): void {
    if (text !== "") this.send(encodePaste(text, this.surface.bracketedPaste));
  }

  /**
   * Writes a message from the message box, followed by Enter unless `enter` is false. A message
   * that names an attached picture goes as a paste, which is how a program recognises the path of
   * a dropped file.
   */
  message(text: string, enter: boolean, attachment = false): void {
    const body = text.replace(/[\r\n]+$/, "");
    if (body !== "") {
      // Several lines go as a paste, so a program that takes pastes keeps them as one message.
      const pasted = attachment || /[\r\n]/.test(body);
      this.send(pasted ? encodePaste(body, this.surface.bracketedPaste) : body);
    }
    if (!enter) return;
    const wait = body === "" ? 0 : attachment ? ENTER_AFTER_ATTACHMENT_MS : ENTER_DELAY_MS;
    window.clearTimeout(this.enterTimer);
    this.enterTimer = window.setTimeout(() => this.send("\r"), wait);
  }

  tapModifier(key: StickyKey): void {
    this.set({ sticky: tapSticky(this.state.sticky, key) });
  }

  lockModifier(key: StickyKey): void {
    this.set({ sticky: lockSticky(this.state.sticky, key) });
  }

  jumpToBottom(): void {
    this.surface.follow();
  }

  // Taps

  /**
   * A tap at a point of the screen. A path under it opens in Files once the Mac has said it is
   * there; otherwise a program that reads the mouse gets a click, and anything else is left to the
   * keyboard. Decided at once whenever it can be, since only a tap may raise the keyboard.
   */
  tap(x: number, y: number): TapResult {
    const cell = this.surface.cellAtPoint(x, y);
    if (cell === null) return "keyboard";
    this.tapCount += 1;
    this.set({ checking: null });
    const mouse = this.surface.mouseTracking !== "none";
    const web = webLink(this.surface.linkAt(cell));
    if (web !== null) {
      window.open(web, "_blank", "noopener,noreferrer");
      return "handled";
    }
    const targets = targetsAt(
      this.surface,
      cell,
      this.cwd,
      !mouse && !this.surface.alternateScreen,
    );
    const known = targets.length === 0 ? null : knownTarget(targets);
    if (known !== null && known !== "unknown") {
      openPath(known.target, known.kind);
      return "handled";
    }
    if (known === null) {
      if (mouse) {
        this.surface.click(cell);
        return "handled";
      }
      return "keyboard";
    }
    void this.checkThenOpen(targets, mouse ? cell : null);
    return "handled";
  }

  /** Asks the Mac, then opens what is there, or clicks `orClick` when nothing is. */
  private async checkThenOpen(targets: PathTarget[], orClick: BufferCell | null): Promise<void> {
    const count = this.tapCount;
    // The shortest reading is the one sure to be under the finger; longer ones are guesses.
    this.set({ checking: targets[targets.length - 1].cells });
    const found = await findTarget(targets);
    if (count !== this.tapCount) return;
    this.set({ checking: null });
    if (found) openPath(found.target, found.kind);
    else if (orClick) this.surface.click(orClick);
  }

  /** An OSC 8 link clicked with a mouse. */
  private openLink(uri: string): void {
    const web = webLink(uri);
    if (web !== null) {
      window.open(web, "_blank", "noopener,noreferrer");
      return;
    }
    const path = fileUrlPath(uri);
    if (path === null) return;
    void findTarget([{ path, line: null, column: null, cells: [] }]).then((found) => {
      if (found) openPath(found.target, found.kind);
    });
  }

  /** With a mouse, paths are links that underline under the pointer and open with a click. */
  private providePathLinks(): void {
    const { terminal } = this.surface;
    terminal.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = lineNumber - 1;
        const { text, cells } = this.surface.logicalLine(line);
        const links = findPathsTouching(text, cells, line).flatMap((found) => {
          const first = found.cells[0];
          const last = found.cells[found.cells.length - 1];
          if (!first || !last) return [];
          return [
            {
              text: text.slice(found.start, found.end),
              range: {
                start: { x: first.col + 1, y: first.line + 1 },
                end: { x: last.col + 1, y: last.line + 1 },
              },
              decorations: { pointerCursor: true, underline: true },
              activate: () => {
                const targets = targetsAt(this.surface, first, this.cwd, false);
                void findTarget(targets).then((hit) => {
                  if (hit) openPath(hit.target, hit.kind);
                });
              },
            },
          ];
        });
        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  private set(change: Partial<ControllerState>): void {
    const next = { ...this.state, ...change };
    if (
      next.sticky === this.state.sticky &&
      next.scrolledUp === this.state.scrolledUp &&
      next.checking === this.state.checking
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** The paths of a line that have a character on buffer line `line`. */
function findPathsTouching(text: string, cells: readonly BufferCell[], line: number) {
  return findPaths(text)
    .map((found) => ({ ...found, cells: cells.slice(found.start, found.end) }))
    .filter((found) => found.cells.some((cell) => cell.line === line));
}
