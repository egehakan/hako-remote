import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeKey,
  encodeKeyEvent,
  encodePaste,
  encodeText,
  type KeyEventLike,
  NO_MODIFIERS,
} from "../src/lib/terminal/keys.ts";

const NORMAL = { applicationCursor: false };
const APPLICATION = { applicationCursor: true };
const CTRL = { ...NO_MODIFIERS, ctrl: true };
const ALT = { ...NO_MODIFIERS, alt: true };
const SHIFT = { ...NO_MODIFIERS, shift: true };

test("arrows follow the cursor key mode the program asked for", () => {
  assert.equal(encodeKey("ArrowUp", NO_MODIFIERS, NORMAL), "\x1b[A");
  assert.equal(encodeKey("ArrowDown", NO_MODIFIERS, NORMAL), "\x1b[B");
  assert.equal(encodeKey("ArrowRight", NO_MODIFIERS, NORMAL), "\x1b[C");
  assert.equal(encodeKey("ArrowLeft", NO_MODIFIERS, NORMAL), "\x1b[D");
  assert.equal(encodeKey("ArrowUp", NO_MODIFIERS, APPLICATION), "\x1bOA");
  assert.equal(encodeKey("Home", NO_MODIFIERS, APPLICATION), "\x1bOH");
  assert.equal(encodeKey("End", NO_MODIFIERS, NORMAL), "\x1b[F");
});

test("a modified arrow uses the CSI form in either mode", () => {
  assert.equal(encodeKey("ArrowLeft", CTRL, NORMAL), "\x1b[1;5D");
  assert.equal(encodeKey("ArrowLeft", CTRL, APPLICATION), "\x1b[1;5D");
  assert.equal(encodeKey("ArrowRight", ALT, NORMAL), "\x1b[1;3C");
  assert.equal(encodeKey("ArrowUp", SHIFT, NORMAL), "\x1b[1;2A");
  assert.equal(encodeKey("ArrowUp", { ctrl: true, alt: true, shift: true }, NORMAL), "\x1b[1;8A");
});

test("paging and function keys", () => {
  assert.equal(encodeKey("PageUp", NO_MODIFIERS, NORMAL), "\x1b[5~");
  assert.equal(encodeKey("PageDown", NO_MODIFIERS, NORMAL), "\x1b[6~");
  assert.equal(encodeKey("Delete", NO_MODIFIERS, NORMAL), "\x1b[3~");
  assert.equal(encodeKey("Delete", CTRL, NORMAL), "\x1b[3;5~");
  assert.equal(encodeKey("F1", NO_MODIFIERS, NORMAL), "\x1bOP");
  assert.equal(encodeKey("F4", SHIFT, NORMAL), "\x1b[1;2S");
  assert.equal(encodeKey("F5", NO_MODIFIERS, NORMAL), "\x1b[15~");
  assert.equal(encodeKey("F12", NO_MODIFIERS, NORMAL), "\x1b[24~");
});

test("Esc, Tab, Shift+Tab, Enter and Backspace", () => {
  assert.equal(encodeKey("Escape", NO_MODIFIERS, NORMAL), "\x1b");
  assert.equal(encodeKey("Tab", NO_MODIFIERS, NORMAL), "\t");
  assert.equal(encodeKey("Tab", SHIFT, NORMAL), "\x1b[Z");
  assert.equal(encodeKey("Enter", NO_MODIFIERS, NORMAL), "\r");
  assert.equal(encodeKey("Enter", ALT, NORMAL), "\x1b\r");
  assert.equal(encodeKey("Backspace", NO_MODIFIERS, NORMAL), "\x7f");
  assert.equal(encodeKey("Backspace", CTRL, NORMAL), "\b");
  assert.equal(encodeKey("Backspace", ALT, NORMAL), "\x1b\x7f");
});

test("Ctrl turns letters and some punctuation into control codes", () => {
  assert.equal(encodeKey("c", CTRL, NORMAL), "\x03");
  assert.equal(encodeKey("C", CTRL, NORMAL), "\x03");
  assert.equal(encodeKey("d", CTRL, NORMAL), "\x04");
  assert.equal(encodeKey("l", CTRL, NORMAL), "\x0c");
  assert.equal(encodeKey("r", CTRL, NORMAL), "\x12");
  assert.equal(encodeKey("z", CTRL, NORMAL), "\x1a");
  assert.equal(encodeKey("[", CTRL, NORMAL), "\x1b");
  assert.equal(encodeKey(" ", CTRL, NORMAL), "\x00");
  assert.equal(encodeKey("\\", CTRL, NORMAL), "\x1c");
  assert.equal(encodeKey("_", CTRL, NORMAL), "\x1f");
  assert.equal(encodeKey("é", CTRL, NORMAL), "é");
});

test("Alt prefixes Esc, also on top of Ctrl", () => {
  assert.equal(encodeKey("b", ALT, NORMAL), "\x1bb");
  assert.equal(encodeKey("c", { ctrl: true, alt: true, shift: false }, NORMAL), "\x1b\x03");
});

test("plain characters pass through and nameless keys send nothing", () => {
  assert.equal(encodeKey("|", NO_MODIFIERS, NORMAL), "|");
  assert.equal(encodeKey("ş", NO_MODIFIERS, NORMAL), "ş");
  assert.equal(encodeKey("😀", NO_MODIFIERS, NORMAL), "😀");
  assert.equal(encodeKey("Shift", NO_MODIFIERS, NORMAL), null);
  assert.equal(encodeKey("AudioVolumeUp", NO_MODIFIERS, NORMAL), null);
});

test("typed text takes a sticky modifier on its first character only", () => {
  assert.equal(encodeText("c", CTRL, NORMAL), "\x03");
  assert.equal(encodeText("cd", CTRL, NORMAL), "\x03d");
  assert.equal(encodeText("f", ALT, NORMAL), "\x1bf");
  assert.equal(encodeText("ls\n", NO_MODIFIERS, NORMAL), "ls\r");
  assert.equal(encodeText("a\r\nb", NO_MODIFIERS, NORMAL), "a\rb");
  assert.equal(encodeText("", CTRL, NORMAL), "");
});

test("paste is wrapped only in bracketed paste mode and cannot end the bracket itself", () => {
  assert.equal(encodePaste("a\nb", false), "a\rb");
  assert.equal(encodePaste("a\r\nb", true), "\x1b[200~a\rb\x1b[201~");
  assert.equal(encodePaste("x\x1b[201~rm -rf", true), "\x1b[200~xrm -rf\x1b[201~");
});

function event(key: string, held: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...held };
}

const NO_STICKY = { ctrl: false, alt: false };

test("a hardware keyboard: named keys and Ctrl combinations are encoded", () => {
  assert.equal(encodeKeyEvent(event("ArrowUp"), NO_STICKY, APPLICATION), "\x1bOA");
  assert.equal(encodeKeyEvent(event("Tab", { shiftKey: true }), NO_STICKY, NORMAL), "\x1b[Z");
  assert.equal(encodeKeyEvent(event("c", { ctrlKey: true }), NO_STICKY, NORMAL), "\x03");
  assert.equal(
    encodeKeyEvent(event("C", { ctrlKey: true, shiftKey: true }), NO_STICKY, NORMAL),
    "\x03",
  );
  assert.equal(encodeKeyEvent(event("Enter", { altKey: true }), NO_STICKY, NORMAL), "\x1b\r");
  assert.equal(
    encodeKeyEvent(event("ArrowLeft", { altKey: true }), NO_STICKY, NORMAL),
    "\x1b[1;3D",
  );
});

test("a hardware keyboard: text, Cmd shortcuts and composition are left to the browser", () => {
  assert.equal(encodeKeyEvent(event("a"), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("∫", { altKey: true }), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("v", { metaKey: true }), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("Shift", { shiftKey: true }), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("Dead", { altKey: true }), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("Enter", { isComposing: true }), NO_STICKY, NORMAL), null);
  assert.equal(encodeKeyEvent(event("Unidentified", { keyCode: 229 }), NO_STICKY, NORMAL), null);
});

test("a hardware keyboard: a sticky modifier from the key bar joins a named key", () => {
  assert.equal(
    encodeKeyEvent(event("ArrowRight"), { ctrl: true, alt: false }, NORMAL),
    "\x1b[1;5C",
  );
  assert.equal(encodeKeyEvent(event("Backspace"), { ctrl: false, alt: true }, NORMAL), "\x1b\x7f");
});
