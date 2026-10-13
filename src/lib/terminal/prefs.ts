// How this device likes its terminals, remembered between visits.

export type InputMode = "keys" | "message";

export type TerminalPrefs = {
  /** Whether typing goes key by key to the terminal, or is written in the message box first. */
  inputMode: InputMode;
  /** True when the terminal on the Mac is resized to this screen instead of being scaled to fit. */
  fitPhone: boolean;
  /** Magnification over "the whole width fits" while the Mac keeps its own size. */
  macZoom: number;
  /** Font size in CSS pixels while the terminal is fitted to this screen, or null for the Mac's. */
  phoneFontSize: number | null;
};

const STORAGE_KEY = "hako.terminal.v1";
const DEFAULTS: TerminalPrefs = {
  inputMode: "keys",
  fitPhone: false,
  macZoom: 1,
  phoneFontSize: null,
};

export const MAC_ZOOM_RANGE = { min: 1, max: 8 };
export const PHONE_FONT_RANGE = { min: 7, max: 28 };

export function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function read(): TerminalPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<TerminalPrefs>;
    return {
      inputMode: stored.inputMode === "message" ? "message" : "keys",
      fitPhone: stored.fitPhone === true,
      macZoom:
        typeof stored.macZoom === "number"
          ? clamp(stored.macZoom, MAC_ZOOM_RANGE)
          : DEFAULTS.macZoom,
      phoneFontSize:
        typeof stored.phoneFontSize === "number"
          ? clamp(stored.phoneFontSize, PHONE_FONT_RANGE)
          : null,
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

export const terminalPrefs = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): TerminalPrefs => prefs,
  set(change: Partial<TerminalPrefs>): void {
    prefs = { ...prefs, ...change };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Private browsing or a full disk: the choice still holds until the page is closed.
    }
    for (const listener of listeners) listener();
  },
};

/**
 * True when the device is driven by touch, which decides how input reaches the terminal. Setting
 * `localStorage["hako.touch"]` to "1" or "0" overrides the guess, to try the phone's input path in
 * a desktop browser.
 */
export function isTouchDevice(): boolean {
  try {
    const forced = localStorage.getItem("hako.touch");
    if (forced === "1") return true;
    if (forced === "0") return false;
  } catch {
    // Fall through to the guess.
  }
  return navigator.maxTouchPoints > 0 && window.matchMedia("(any-pointer: coarse)").matches;
}
