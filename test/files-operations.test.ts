import assert from "node:assert/strict";
import { test } from "node:test";
import { planPaste, type PasteItem } from "../src/lib/files/paste-plan.ts";
import { firstFreeName, keepBothNameFor } from "../shared/operations.ts";

test("keep both numbers a file before its extension and a directory after its whole name", () => {
  assert.equal(keepBothNameFor("notes.txt", false, 2), "notes (2).txt");
  assert.equal(keepBothNameFor("archive.tar.gz", false, 3), "archive.tar (3).gz");
  assert.equal(keepBothNameFor(".env", false, 2), ".env (2)");
  assert.equal(keepBothNameFor("Makefile", false, 2), "Makefile (2)");
  assert.equal(keepBothNameFor("v1.2", true, 2), "v1.2 (2)");
  assert.equal(keepBothNameFor("photos", true, 10), "photos (10)");
});

test("keep both stays within 255 bytes by shortening the name, never the number", () => {
  const long = `${"é".repeat(127)}.md`;
  const file = keepBothNameFor(long, false, 2);
  assert.ok(file.endsWith(" (2).md"));
  assert.ok(Buffer.byteLength(file) <= 255);
  const folder = keepBothNameFor("x".repeat(255), true, 12);
  assert.ok(folder.endsWith(" (12)"));
  assert.equal(Buffer.byteLength(folder), 255);
});

test("the first free name skips taken ones, ignoring case and Unicode normalisation", () => {
  assert.equal(firstFreeName("a.txt", false, ["b.txt"]), "a.txt");
  assert.equal(firstFreeName("a.txt", false, ["A.TXT", "a (2).txt"]), "a (3).txt");
  // "café" spelt with a combining accent is the same name on a Mac's disk.
  assert.equal(firstFreeName("café", true, ["café"]), "café (2)");
});

const item = (path: string, isDirectory = false): PasteItem => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDirectory,
});

test("a paste without names in the way goes in one request that fails rather than replaces", () => {
  const plan = planPaste({
    mode: "copy",
    items: [item("/a/one.txt"), item("/a/docs", true)],
    destination: "/b",
    existing: ["other.txt"],
    choice: null,
  });
  assert.equal(plan.needsChoice, false);
  assert.deepEqual(plan.requests, [{ sources: ["/a/one.txt", "/a/docs"], on_conflict: "fail" }]);
  assert.deepEqual(plan.untouched, []);
});

test("names in the way ask once for the batch, and nothing is sent until answered", () => {
  const input = {
    mode: "move" as const,
    items: [item("/a/one.txt"), item("/a/Two.txt"), item("/a/three.txt")],
    destination: "/b",
    existing: ["two.txt", "three.txt"],
    choice: null,
  };
  const asked = planPaste(input);
  assert.equal(asked.needsChoice, true);
  assert.deepEqual(
    asked.conflicts.map((conflict) => conflict.name),
    ["Two.txt", "three.txt"],
  );
  assert.deepEqual(asked.requests, []);

  assert.deepEqual(planPaste({ ...input, choice: "rename" }).requests, [
    { sources: ["/a/one.txt", "/a/Two.txt", "/a/three.txt"], on_conflict: "rename" },
  ]);
  assert.deepEqual(planPaste({ ...input, choice: "replace" }).requests, [
    { sources: ["/a/one.txt", "/a/Two.txt", "/a/three.txt"], on_conflict: "replace" },
  ]);
  const skipped = planPaste({ ...input, choice: "skip" });
  assert.deepEqual(skipped.requests, [{ sources: ["/a/one.txt"], on_conflict: "fail" }]);
  assert.deepEqual(
    skipped.untouched.map((left) => left.name),
    ["Two.txt", "three.txt"],
  );
});

test("two items of one name from different folders are in each other's way", () => {
  const plan = planPaste({
    mode: "copy",
    items: [item("/a/x.txt"), item("/c/x.txt")],
    destination: "/b",
    existing: [],
    choice: null,
  });
  assert.equal(plan.needsChoice, true);
  assert.deepEqual(
    plan.conflicts.map((conflict) => conflict.path),
    ["/c/x.txt"],
  );
});

test("copying into the same folder duplicates; moving there does nothing", () => {
  const copy = planPaste({
    mode: "copy",
    items: [item("/b/x.txt"), item("/a/y.txt")],
    destination: "/b",
    existing: ["x.txt", "y.txt"],
    choice: "skip",
  });
  assert.deepEqual(copy.requests, [{ sources: ["/b/x.txt"], on_conflict: "rename" }]);
  assert.deepEqual(
    copy.untouched.map((left) => left.path),
    ["/a/y.txt"],
  );

  const move = planPaste({
    mode: "move",
    items: [item("/b/x.txt")],
    destination: "/b",
    existing: ["x.txt"],
    choice: null,
  });
  assert.equal(move.needsChoice, false);
  assert.deepEqual(move.requests, []);
  assert.deepEqual(
    move.untouched.map((left) => left.path),
    ["/b/x.txt"],
  );
});

test("a batch over 500 items is sent in requests of at most 500", () => {
  const items = Array.from({ length: 1201 }, (_, index) => item(`/a/f${index}`));
  const plan = planPaste({ mode: "copy", items, destination: "/b", existing: [], choice: null });
  assert.deepEqual(
    plan.requests.map((request) => request.sources.length),
    [500, 500, 201],
  );
});
