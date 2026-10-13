import assert from "node:assert/strict";
import { test } from "node:test";
import { diffInput } from "../src/lib/terminal/input-diff.ts";
import {
  activeSticky,
  consumeSticky,
  lockSticky,
  NO_STICKY,
  tapSticky,
} from "../src/lib/terminal/modifiers.ts";
import { SeqTracker } from "../src/lib/terminal/seq.ts";

test("sticky modifier: a tap arms it for one key", () => {
  const armed = tapSticky(NO_STICKY, "ctrl");
  assert.deepEqual(armed, { ctrl: "armed", alt: "off" });
  assert.deepEqual(activeSticky(armed), { ctrl: true, alt: false });
  assert.deepEqual(consumeSticky(armed), NO_STICKY);
});

test("sticky modifier: a second tap lets it go without sending anything", () => {
  assert.deepEqual(tapSticky(tapSticky(NO_STICKY, "ctrl"), "ctrl"), NO_STICKY);
});

test("sticky modifier: a locked one survives keys until it is tapped", () => {
  const locked = lockSticky(NO_STICKY, "ctrl");
  assert.equal(consumeSticky(locked), locked);
  assert.deepEqual(activeSticky(consumeSticky(locked)), { ctrl: true, alt: false });
  assert.deepEqual(tapSticky(locked, "ctrl"), NO_STICKY);
});

test("sticky modifier: Ctrl and Alt are independent and one key uses up both", () => {
  const both = tapSticky(tapSticky(NO_STICKY, "ctrl"), "alt");
  assert.deepEqual(activeSticky(both), { ctrl: true, alt: true });
  assert.deepEqual(consumeSticky(both), NO_STICKY);
  const mixed = tapSticky(lockSticky(NO_STICKY, "alt"), "ctrl");
  assert.deepEqual(consumeSticky(mixed), { ctrl: "off", alt: "locked" });
});

test("sticky modifier: consuming nothing keeps the same object, so nothing re-renders", () => {
  assert.equal(consumeSticky(NO_STICKY), NO_STICKY);
});

test("output order: frames that continue the stream are applied whole", () => {
  const tracker = new SeqTracker();
  tracker.reset(100);
  assert.deepEqual(tracker.accept(100, 10), { kind: "apply", offset: 0 });
  assert.deepEqual(tracker.accept(110, 5), { kind: "apply", offset: 0 });
});

test("output order: a frame beyond the expected offset is a gap, and stays one", () => {
  const tracker = new SeqTracker();
  tracker.reset(100);
  assert.deepEqual(tracker.accept(101, 10), { kind: "gap" });
  assert.deepEqual(tracker.accept(111, 10), { kind: "gap" });
  tracker.reset(121);
  assert.deepEqual(tracker.accept(121, 4), { kind: "apply", offset: 0 });
});

test("output order: an empty frame beyond the expected offset announces a gap", () => {
  const tracker = new SeqTracker();
  tracker.reset(100);
  // Nothing to write, and nothing missing: the stream stands where it stood.
  assert.deepEqual(tracker.accept(100, 0), { kind: "skip" });
  assert.deepEqual(tracker.accept(100, 4), { kind: "apply", offset: 0 });
  // Bytes were left out and no output follows: the empty frame alone says so.
  assert.deepEqual(tracker.accept(160, 0), { kind: "gap" });
  // The snapshot asked for because of it starts where the empty frame said.
  tracker.reset(160);
  assert.deepEqual(tracker.accept(160, 0), { kind: "skip" });
  assert.deepEqual(tracker.accept(160, 2), { kind: "apply", offset: 0 });
});

test("output order: what the snapshot already covers is skipped", () => {
  const tracker = new SeqTracker();
  tracker.reset(100);
  assert.deepEqual(tracker.accept(80, 20), { kind: "skip" });
  assert.deepEqual(tracker.accept(90, 5), { kind: "skip" });
  assert.deepEqual(tracker.accept(100, 0), { kind: "skip" });
});

test("output order: a frame that straddles the snapshot is applied from the snapshot on", () => {
  const tracker = new SeqTracker();
  tracker.reset(100);
  assert.deepEqual(tracker.accept(95, 10), { kind: "apply", offset: 5 });
  assert.deepEqual(tracker.accept(105, 1), { kind: "apply", offset: 0 });
});

test("output order: nothing is applied before the first snapshot or after clear", () => {
  const tracker = new SeqTracker();
  assert.deepEqual(tracker.accept(0, 10), { kind: "skip" });
  tracker.reset(0);
  tracker.clear();
  assert.deepEqual(tracker.accept(0, 10), { kind: "skip" });
});

test("text field: typing appends", () => {
  assert.deepEqual(diffInput(" ", " a"), { erase: 0, insert: "a" });
  assert.deepEqual(diffInput(" hel", " hello"), { erase: 0, insert: "lo" });
});

test("text field: deleting rubs out, also into the sentinel", () => {
  assert.deepEqual(diffInput(" ab", " a"), { erase: 1, insert: "" });
  assert.deepEqual(diffInput(" ", ""), { erase: 1, insert: "" });
});

test("text field: a composition or correction that rewrites the word is erased and retyped", () => {
  assert.deepEqual(diffInput(" teh", " the"), { erase: 2, insert: "he" });
  assert.deepEqual(diffInput(" ㅎ", " 하"), { erase: 1, insert: "하" });
  assert.deepEqual(diffInput(" a", " a"), { erase: 0, insert: "" });
});

test("text field: emoji count as one character and are never split", () => {
  assert.deepEqual(diffInput(" 😀", " "), { erase: 1, insert: "" });
  assert.deepEqual(diffInput(" 😀", " 😁"), { erase: 1, insert: "😁" });
});
