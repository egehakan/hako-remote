import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserFrame } from "../shared/browser.ts";
import { FramePipeline } from "../src/lib/browser/frames.ts";
import { editEvents, keyDownEvent, type KeyLike, pasteEvents } from "../src/lib/browser/keys.ts";
import {
  clampPan,
  fitScale,
  place,
  toPage,
  toStage,
  zoomAround,
} from "../src/lib/browser/mapping.ts";
import { diffInput } from "../src/lib/terminal/input-diff.ts";

const near = (actual: { x: number; y: number } | null, x: number, y: number) => {
  assert.ok(actual, "expected a point on the page");
  assert.ok(Math.abs(actual.x - x) < 1e-6, `x ${actual.x} is not ${x}`);
  assert.ok(Math.abs(actual.y - y) < 1e-6, `y ${actual.y} is not ${y}`);
};

// Mapping

test("mapping: a page scaled down to fit is centred, and a tap maps back to its CSS pixel", () => {
  const stage = { width: 366, height: 700 };
  const page = { width: 1440, height: 900 };
  const scale = fitScale(page, stage);
  assert.equal(scale, 366 / 1440);
  const placement = place(stage, page, scale, { x: 0, y: 0 });
  assert.equal(placement.left, 0);
  assert.equal(placement.top, (700 - 900 * scale) / 2);
  // The page's centre is the stage's centre.
  near(toPage({ x: 183, y: 350 }, placement, page), 720, 450);
  near(toPage(toStage({ x: 100, y: 37.5 }, placement), placement, page), 100, 37.5);
});

test("mapping: Fit draws the page at one stage pixel per CSS pixel, from the corner", () => {
  const stage = { width: 390, height: 700 };
  const placement = place(stage, stage, 1, { x: 0, y: 0 });
  assert.deepEqual(placement, { left: 0, top: 0, scale: 1 });
  near(toPage({ x: 12.5, y: 640 }, placement, stage), 12.5, 640);
});

test("mapping: a point off the picture is not on the page", () => {
  const stage = { width: 400, height: 800 };
  const page = { width: 200, height: 300 };
  const placement = place(stage, page, 1, { x: 0, y: 0 });
  assert.equal(toPage({ x: 50, y: 400 }, placement, page), null);
  assert.equal(toPage({ x: 200, y: 200 }, placement, page), null);
});

test("mapping: zoomed and panned, a tap still lands on the pixel under the finger", () => {
  const stage = { width: 390, height: 600 };
  const page = { width: 393, height: 852 };
  const scale = 2;
  const pan = clampPan(stage, page, scale, { x: -150, y: 300 });
  const placement = place(stage, page, scale, pan);
  // Centred, the picture's left edge is at (390 - 786) / 2 = -198; moved 150 further left.
  assert.equal(placement.left, -348);
  assert.equal(placement.top, (600 - 1704) / 2 + 300);
  near(toPage({ x: 0, y: 0 }, placement, page), 174, (552 - 300) / 2);
  near(toPage({ x: 195, y: 300 }, placement, page), (195 + 348) / 2, (300 - placement.top) / 2);
});

test("mapping: a pan stops where the picture's edge meets the stage's", () => {
  const stage = { width: 390, height: 600 };
  const page = { width: 393, height: 852 };
  assert.deepEqual(clampPan(stage, page, 2, { x: -5000, y: 5000 }), { x: -198, y: 552 });
  // Smaller than the stage on both axes: nothing to pan.
  assert.deepEqual(clampPan(stage, page, 0.5, { x: 40, y: -40 }), { x: 0, y: 0 });
  const placement = place(stage, page, 2, { x: -5000, y: 5000 });
  assert.equal(placement.left + page.width * 2, stage.width);
  assert.equal(placement.top, 0);
});

test("mapping: a pinch keeps the page point under the fingers in place", () => {
  const stage = { width: 390, height: 600 };
  const page = { width: 393, height: 852 };
  const fit = fitScale(page, stage);
  const focus = { x: 200, y: 150 };
  const before = place(stage, page, fit, { x: 0, y: 0 });
  const under = toPage(focus, before, page);
  const pan = zoomAround(stage, page, { scale: fit, pan: { x: 0, y: 0 } }, 1.5, focus);
  const after = place(stage, page, 1.5, pan);
  assert.ok(under);
  near(toPage(focus, after, page), under.x, under.y);
});

test("mapping: during a rotation a tap maps against the picture on screen, not the new size", () => {
  const stage = { width: 390, height: 700 };
  const portrait = { width: 393, height: 852 };
  const landscape = { width: 852, height: 393 };
  // The owner rotated; the last picture is still the portrait one, and that is what was tapped.
  const shown = place(stage, portrait, fitScale(portrait, stage), { x: 0, y: 0 });
  const tap = toStage({ x: 380, y: 840 }, shown);
  near(toPage(tap, shown, portrait), 380, 840);
  // Once the rotated picture is drawn, the same kind of tap maps against its own size.
  const rotated = place(stage, landscape, fitScale(landscape, stage), { x: 0, y: 0 });
  near(toPage(toStage({ x: 840, y: 380 }, rotated), rotated, landscape), 840, 380);
  assert.equal(toPage(tap, rotated, landscape), null);
});

// Keys

const key = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

test("keys: special keys from the text field go as keys, with their code", () => {
  assert.deepEqual(keyDownEvent(key("Enter")), {
    type: "key",
    key: "Enter",
    code: "Enter",
    modifiers: 0,
    action: "press",
  });
  assert.deepEqual(keyDownEvent(key("ArrowLeft", { shiftKey: true })), {
    type: "key",
    key: "ArrowLeft",
    code: "ArrowLeft",
    modifiers: 8,
    action: "press",
  });
  assert.equal(keyDownEvent(key("Backspace"))?.type, "key");
  assert.equal(keyDownEvent(key("Escape"))?.type, "key");
  assert.equal(keyDownEvent(key("Tab", { shiftKey: true }))?.type, "key");
});

test("keys: letters are left to the field, shortcuts are keys, and Cmd+V waits for the paste", () => {
  assert.equal(keyDownEvent(key("a")), null);
  assert.equal(keyDownEvent(key("é")), null);
  assert.equal(keyDownEvent(key("Unidentified")), null);
  assert.equal(keyDownEvent(key("Process")), null);
  assert.deepEqual(keyDownEvent(key("a", { metaKey: true, code: "KeyA" })), {
    type: "key",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    action: "press",
  });
  assert.deepEqual(keyDownEvent(key("z", { metaKey: true, shiftKey: true })), {
    type: "key",
    key: "z",
    code: "KeyZ",
    modifiers: 12,
    action: "press",
  });
  assert.equal(keyDownEvent(key("c", { ctrlKey: true }))?.type, "key");
  assert.equal(keyDownEvent(key("v", { metaKey: true })), null);
  assert.equal(keyDownEvent(key("v", { ctrlKey: true })), null);
  assert.equal(keyDownEvent(key("Shift", { shiftKey: true })), null);
  assert.equal(keyDownEvent(key("Meta", { metaKey: true })), null);
});

test("keys: typing, corrections and dictation read from the field become text and Backspaces", () => {
  // A word typed letter by letter.
  assert.deepEqual(editEvents(diffInput(" ", " h")), [{ type: "text", text: "h" }]);
  // Autocorrect replaced "teh" with "the".
  assert.deepEqual(editEvents(diffInput(" teh", " the")), [
    { type: "key", key: "Backspace", code: "Backspace", modifiers: 0, action: "press" },
    { type: "key", key: "Backspace", code: "Backspace", modifiers: 0, action: "press" },
    { type: "text", text: "he" },
  ]);
  // A keyboard that does not report Backspace empties the field instead.
  assert.deepEqual(editEvents(diffInput(" ", "")), [
    { type: "key", key: "Backspace", code: "Backspace", modifiers: 0, action: "press" },
  ]);
  // Dictation in any language arrives whole, a line break as Enter.
  assert.deepEqual(editEvents(diffInput(" ", " Merhaba dünya\nnasılsın")), [
    { type: "text", text: "Merhaba dünya" },
    { type: "key", key: "Enter", code: "Enter", modifiers: 0, action: "press" },
    { type: "text", text: "nasılsın" },
  ]);
  // An emoji is never split.
  assert.deepEqual(editEvents(diffInput(" 👍", " 👋")), [
    { type: "key", key: "Backspace", code: "Backspace", modifiers: 0, action: "press" },
    { type: "text", text: "👋" },
  ]);
});

test("keys: a paste is one piece of text, line breaks kept", () => {
  assert.deepEqual(pasteEvents("a\r\nb"), [{ type: "text", text: "a\nb" }]);
  assert.deepEqual(pasteEvents(""), []);
});

// Frames

function frame(n: number): BrowserFrame {
  return { bid: 7, frame: n, width: 390, height: 844, format: 1, image: new Uint8Array() };
}

function harness() {
  const log: string[] = [];
  const decoding: { n: number; resolve: () => void }[] = [];
  const pipeline = new FramePipeline<number>({
    decode: (f) =>
      new Promise<number>((resolve) => {
        log.push(`decode ${f.frame}`);
        decoding.push({ n: f.frame, resolve: () => resolve(f.frame) });
      }),
    draw: (picture) => log.push(`draw ${picture}`),
    release: () => {},
    ack: (bid, n) => log.push(`ack ${bid}:${n}`),
  });
  const finish = async () => {
    decoding.shift()?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { log, pipeline, finish, decoding };
}

test("frames: one decodes at a time, and each is acknowledged after it is drawn", async () => {
  const { log, pipeline, finish } = harness();
  pipeline.push(frame(1));
  pipeline.push(frame(2));
  assert.deepEqual(log, ["decode 1"]);
  await finish();
  assert.deepEqual(log, ["decode 1", "draw 1", "ack 7:1", "decode 2"]);
  await finish();
  assert.deepEqual(log.slice(4), ["draw 2", "ack 7:2"]);
});

test("frames: only the newest waiting frame is drawn; the others are acknowledged with it, in order", async () => {
  const { log, pipeline, finish } = harness();
  pipeline.push(frame(1));
  pipeline.push(frame(2));
  pipeline.push(frame(3));
  pipeline.push(frame(4));
  await finish();
  assert.deepEqual(log, ["decode 1", "draw 1", "ack 7:1", "decode 4"]);
  pipeline.push(frame(5));
  await finish();
  assert.deepEqual(log.slice(4), ["draw 4", "ack 7:2", "ack 7:3", "ack 7:4", "decode 5"]);
  await finish();
  assert.deepEqual(log.slice(9), ["draw 5", "ack 7:5"]);
});

test("frames: after a reset nothing of the old session is drawn or acknowledged", async () => {
  const { log, pipeline, decoding } = harness();
  pipeline.push(frame(1));
  pipeline.push(frame(2));
  pipeline.reset();
  decoding.shift()?.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(log, ["decode 1"]);
  pipeline.push({ ...frame(1), bid: 8 });
  assert.deepEqual(log, ["decode 1", "decode 1"]);
});
