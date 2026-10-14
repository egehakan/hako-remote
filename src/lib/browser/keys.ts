// What the phone's hidden text field, a key of the key row, or a hardware keyboard sends to the
// Mac's browser: `text` for what is typed, pasted or dictated, `key` for keys that do something.

import {
  type BrowserInputEvent,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_SHIFT,
} from "../../../shared/browser.ts";
import type { InputEdit } from "../terminal/input-diff.ts";

export type KeyLike = {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** The keys that are sent as keys, not as text, whatever modifiers are held. */
const SPECIAL_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

/** `KeyboardEvent.code` for the keys a key row sends, which has no keyboard event to read it from. */
const CODES: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  " ": "Space",
};

export function modifierBits(event: Omit<KeyLike, "key" | "code">): number {
  return (
    (event.altKey ? MOD_ALT : 0) |
    (event.ctrlKey ? MOD_CTRL : 0) |
    (event.metaKey ? MOD_META : 0) |
    (event.shiftKey ? MOD_SHIFT : 0)
  );
}

/** The `code` of a key that is named by its `key` alone. */
export function codeFor(key: string): string {
  const known = CODES[key];
  if (known) return known;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "";
}

/** A key pressed and let go, as the key row and the field send them. */
export function keyPress(key: string, modifiers = 0): BrowserInputEvent {
  return { type: "key", key, code: codeFor(key), modifiers, action: "press" };
}

/**
 * What a key-down in the text field sends by itself, or null when the field is left to take the
 * key and its text is read from it afterwards. Special keys and shortcuts (a letter with Cmd or
 * Ctrl) are keys. Cmd+V and Ctrl+V are left alone: the paste that follows carries the text, from
 * this device's clipboard. Keys of an input method that is composing (`Process`, `Unidentified`)
 * are the field's.
 */
export function keyDownEvent(event: KeyLike): BrowserInputEvent | null {
  const modifiers = modifierBits(event);
  if (SPECIAL_KEYS.has(event.key)) {
    return {
      type: "key",
      key: event.key,
      code: event.code || codeFor(event.key),
      modifiers,
      action: "press",
    };
  }
  const shortcut = event.metaKey || event.ctrlKey;
  if (!shortcut || [...event.key].length !== 1) return null;
  if (event.key.toLowerCase() === "v" && !event.altKey && !event.shiftKey) return null;
  return {
    type: "key",
    key: event.key,
    code: event.code || codeFor(event.key),
    modifiers,
    action: "press",
  };
}

/**
 * What a change to the text field sends: a Backspace for each character rubbed out, then what was
 * inserted as text, with each line break as an Enter so that forms and editors take it as one.
 */
export function editEvents(edit: InputEdit): BrowserInputEvent[] {
  const events: BrowserInputEvent[] = [];
  for (let i = 0; i < edit.erase; i++) events.push(keyPress("Backspace"));
  const lines = edit.insert.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) events.push(keyPress("Enter"));
    if (line !== "") events.push({ type: "text", text: line });
  });
  return events;
}

/** Pasted text goes as it is, in one piece, so a page receives it as one insertion. */
export function pasteEvents(text: string): BrowserInputEvent[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized === "" ? [] : [{ type: "text", text: normalized }];
}
