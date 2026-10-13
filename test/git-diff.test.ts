import assert from "node:assert/strict";
import { test } from "node:test";
import { changedParts, parseDiff } from "../src/lib/git/diff.ts";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 0f9f46c..b75ec82 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,6 +1,7 @@ import { start } from "./start";
 const name = "hako";
-const port = 8787;
+const port = 8788;
+const host = "localhost";
 
 start(name, port);
@@ -40,3 +41,3 @@ export function stop() {
   close();
-  log("stopped")
+  log("stopped");
 }
`;

test("lines are numbered on both sides and counted", () => {
  const diff = parseDiff(MODIFIED);
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 2);
  assert.equal(diff.lineCount, 10);
  const [first, second] = diff.hunks;
  assert.equal(first.range, "@@ -1,6 +1,7 @@");
  assert.equal(first.section, 'import { start } from "./start";');
  assert.deepEqual(
    first.lines.map((line) => [line.kind, line.oldNumber, line.newNumber]),
    [
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ],
  );
  // An empty context line keeps its place in the numbering.
  assert.equal(first.lines[4].text, "");
  assert.deepEqual(
    second.lines.map((line) => [line.oldNumber, line.newNumber]),
    [
      [40, 41],
      [41, null],
      [null, 42],
      [42, 43],
    ],
  );
});

test("a line that replaced one line has the part that changed marked", () => {
  const [, second] = parseDiff(MODIFIED).hunks;
  const removed = second.lines[1];
  const added = second.lines[2];
  assert.deepEqual(added.changed, { from: 16, to: 17 });
  assert.equal(added.text.slice(16, 17), ";");
  assert.deepEqual(removed.changed, { from: 16, to: 16 });
});

test("a run of removed lines is paired only with a run of added lines of the same length", () => {
  const [first] = parseDiff(MODIFIED).hunks;
  // One line out, two in: which of the two replaced it is anyone's guess.
  assert.equal(first.lines[1].changed, null);
  assert.equal(first.lines[2].changed, null);
});

test("a new file has only added lines, numbered from one", () => {
  const diff = parseDiff(
    "diff --git a/notes.md b/notes.md\nnew file mode 100644\nindex 0000000..35a7c6a\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+# Notes\n+one\n",
  );
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text]),
    [
      ["add", null, 1, "# Notes"],
      ["add", null, 2, "one"],
    ],
  );
  assert.deepEqual(diff.notes, []);
});

test("a missing final newline is a note, not a line of the file", () => {
  const diff = parseDiff(
    "--- a/a.toml\n+++ b/a.toml\n@@ -1,2 +1,2 @@\n a = 1\n-b = 2\n+b = 3\n\\ No newline at end of file\n",
  );
  const lines = diff.hunks[0].lines;
  assert.equal(lines.at(-1)!.kind, "note");
  assert.equal(lines.at(-1)!.text, "No newline at end of file");
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
});

test("a rename without a changed line has a note and no hunks", () => {
  const diff = parseDiff(
    "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n",
  );
  assert.equal(diff.hunks.length, 0);
  assert.deepEqual(diff.notes, ["Renamed from old name.txt"]);
});

test("lines that look like headers inside a hunk are lines of the file", () => {
  const diff = parseDiff("@@ -1,2 +1,2 @@\n ---\n-- item\n+++ item\n");
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => [line.kind, line.text]),
    [
      ["context", "---"],
      ["del", "- item"],
      ["add", "++ item"],
    ],
  );
});

test("an empty diff is no hunks at all", () => {
  assert.deepEqual(parseDiff("").hunks, []);
});

test("the changed part is what is left between a shared start and a shared end", () => {
  assert.deepEqual(changedParts("let total = count * 2;", "let total = count * 3;"), {
    before: { from: 20, to: 21 },
    after: { from: 20, to: 21 },
  });
  assert.deepEqual(changedParts("fn ok(id: String)", "fn ok(id: impl Into<String>)"), {
    before: { from: 10, to: 16 },
    after: { from: 10, to: 27 },
  });
  // Something put in the middle: nothing is marked on the old line.
  assert.deepEqual(changedParts("start(name);", "start(name, port);"), {
    before: { from: 10, to: 10 },
    after: { from: 10, to: 16 },
  });
});

test("lines with little in common, or nothing different, are left unmarked", () => {
  assert.equal(changedParts("import a from 'a';", "export const value = 12;"), null);
  assert.equal(changedParts("same", "same"), null);
  assert.equal(changedParts("", "new"), null);
  assert.equal(changedParts("x".repeat(3000), `${"x".repeat(3000)}y`), null);
});
