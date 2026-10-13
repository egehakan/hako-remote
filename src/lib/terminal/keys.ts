// What a terminal emulator sends for a key, as xterm does. Shared by the key bar, the phone's
// text field and hardware keyboards, so every way of pressing a key produces the same bytes.

export type Modifiers = { ctrl: boolean; alt: boolean; shift: boolean };

export type KeyModes = {
  /** DECCKM: full-screen programs switch the arrow keys to `ESC O A` and friends. */
  applicationCursor: boolean;
};

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false };

const ESC = "\x1b";

/** Keys sent as `CSI <letter>`, or `CSI 1 ; <modifier> <letter>` with a modifier held. */
const CURSOR_KEYS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

/** Keys sent as `CSI <number> ~`. */
const TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

const SS3_FUNCTION_KEYS: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/** Characters other than letters that Ctrl turns into a control code. */
const CTRL_PUNCTUATION: Record<string, string> = {
  "@": "\x00",
  " ": "\x00",
  "2": "\x00",
  "[": "\x1b",
  "3": "\x1b",
  "\\": "\x1c",
  "4": "\x1c",
  "]": "\x1d",
  "5": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  _: "\x1f",
  "7": "\x1f",
  "/": "\x1f",
  "-": "\x1f",
  "8": "\x7f",
  "?": "\x7f",
};

/** xterm's modifier parameter: 1 plus Shift (1), Alt (2) and Ctrl (4). */
function modifierParam(mods: Modifiers): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

function controlCode(char: string): string | null {
  const code = char.charCodeAt(0);
  if (char.length !== 1) return null;
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) {
    return String.fromCharCode(code & 0x1f);
  }
  return CTRL_PUNCTUATION[char] ?? null;
}

/**
 * The bytes for one key press. `key` is a `KeyboardEvent.key` name ("ArrowUp", "Enter") or a single
 * character. Returns null for a key that sends nothing by itself, such as Shift.
 */
export function encodeKey(key: string, mods: Modifiers, modes: KeyModes): string | null {
  const param = modifierParam(mods);
  const modified = param > 1;

  const cursor = CURSOR_KEYS[key];
  if (cursor !== undefined) {
    if (modified) return `${ESC}[1;${param}${cursor}`;
    return modes.applicationCursor ? `${ESC}O${cursor}` : `${ESC}[${cursor}`;
  }

  const tilde = TILDE_KEYS[key];
  if (tilde !== undefined) return modified ? `${ESC}[${tilde};${param}~` : `${ESC}[${tilde}~`;

  const ss3 = SS3_FUNCTION_KEYS[key];
  if (ss3 !== undefined) return modified ? `${ESC}[1;${param}${ss3}` : `${ESC}O${ss3}`;

  const meta = mods.alt ? ESC : "";
  switch (key) {
    case "Enter":
      return `${meta}\r`;
    case "Escape":
      return `${meta}${ESC}`;
    case "Tab":
      return mods.shift ? `${ESC}[Z` : `${meta}\t`;
    case "Backspace":
      return `${meta}${mods.ctrl ? "\b" : "\x7f"}`;
  }

  // Everything else that is longer than one character is a key with no bytes of its own.
  if ([...key].length !== 1) return null;
  if (mods.ctrl) {
    const control = controlCode(key);
    if (control !== null) return `${meta}${control}`;
  }
  return `${meta}${key}`;
}

/** Typed text with the modifiers applied to its first character, which is all a held key reaches. */
export function encodeText(text: string, mods: Modifiers, modes: KeyModes): string {
  if (text === "") return "";
  const typed = text.replace(/\r\n?|\n/g, "\r");
  if (!mods.ctrl && !mods.alt) return typed;
  const [first, ...rest] = [...typed];
  const head = first === "\r" ? encodeKey("Enter", mods, modes) : encodeKey(first, mods, modes);
  return (head ?? first) + rest.join("");
}

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/**
 * Pasted text as the program expects it. In bracketed paste mode the text is wrapped so the program
 * can tell it from typing; the end marker is removed from the text so a paste cannot break out.
 */
export function encodePaste(text: string, bracketed: boolean): string {
  const lines = text.replace(/\r\n?|\n/g, "\r");
  if (!bracketed) return lines;
  return PASTE_START + lines.replaceAll(PASTE_END, "") + PASTE_END;
}

/**
 * One notch of the mouse wheel over a cell, in the SGR form (`CSI < button ; column ; row M`) a
 * program asks for with mode 1006. `column` and `row` count from 1.
 */
export function encodeWheel(direction: "up" | "down", column: number, row: number): string {
  return `${ESC}[<${direction === "up" ? 64 : 65};${column};${row}M`;
}

export type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

const SILENT_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
]);

/**
 * The bytes for a hardware key press, or null when the browser should carry on: text arrives through
 * the text field instead, and Cmd shortcuts (copy, paste, reload) stay with the browser. `sticky`
 * holds the modifiers armed on the key bar.
 */
export function encodeKeyEvent(
  event: KeyEventLike,
  sticky: Pick<Modifiers, "ctrl" | "alt">,
  modes: KeyModes,
): string | null {
  // 229 is what an on-screen keyboard or an input method reports while it is composing.
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.metaKey || SILENT_KEYS.has(event.key)) return null;

  const mods: Modifiers = {
    ctrl: event.ctrlKey || sticky.ctrl,
    alt: event.altKey || sticky.alt,
    shift: event.shiftKey,
  };
  if ([...event.key].length !== 1) return encodeKey(event.key, mods, modes);

  // A plain character, or one the system composed from Option, is text and comes as input.
  if (!event.ctrlKey) return null;
  return encodeKey(event.key, { ...mods, shift: false }, modes);
}
