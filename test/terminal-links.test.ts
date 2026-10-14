import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cellAt,
  fileUrlPath,
  findPaths,
  osc8Uri,
  pathsAt,
  resolvePath,
} from "../src/lib/terminal/links.ts";

const only = (text: string) =>
  findPaths(text).map(({ path, line, column }) => ({ path, line, column }));
const at = (text: string, needle: string) => pathsAt(text, text.indexOf(needle))[0] ?? null;

test("absolute, home and relative paths are found, with their place in the line", () => {
  const text = "see /Users/ege/a.ts and ~/notes/b.md or src/c.tsx, ./d and ../e/f";
  assert.deepEqual(
    findPaths(text).map(({ start, end, path }) => [text.slice(start, end), path]),
    [
      ["/Users/ege/a.ts", "/Users/ege/a.ts"],
      ["~/notes/b.md", "~/notes/b.md"],
      ["src/c.tsx", "src/c.tsx"],
      ["./d", "./d"],
      ["../e/f", "../e/f"],
    ],
  );
});

test("a line and a column after a path are read, and stay part of what is tapped", () => {
  assert.deepEqual(only("src/relay.ts:12"), [{ path: "src/relay.ts", line: 12, column: null }]);
  assert.deepEqual(only("at /a/b.rs:14:9"), [{ path: "/a/b.rs", line: 14, column: 9 }]);
  assert.deepEqual(only("app.ts(30,7): error"), [{ path: "app.ts", line: 30, column: 7 }]);
  const text = "Error in src/x.rs:14:9.";
  const found = at(text, "14");
  assert.equal(found?.path, "src/x.rs");
  assert.equal(text.slice(found?.start, found?.end), "src/x.rs:14:9");
});

test("punctuation around a path is not part of it", () => {
  assert.deepEqual(only("Wrote README.md."), [{ path: "README.md", line: null, column: null }]);
  assert.deepEqual(only("files: a/b.ts, c/d.ts;"), [
    { path: "a/b.ts", line: null, column: null },
    { path: "c/d.ts", line: null, column: null },
  ]);
  assert.deepEqual(only("(see ~/x/y.md)!"), [{ path: "~/x/y.md", line: null, column: null }]);
  assert.deepEqual(only("src/a.ts:12:"), [{ path: "src/a.ts", line: 12, column: null }]);
});

test("Claude Code's tool lines give the path inside the brackets", () => {
  assert.equal(at("⏺ Read(src/lib/terminal/links.ts)", "src")?.path, "src/lib/terminal/links.ts");
  assert.equal(at("⏺ Update(app/main.py)", "main")?.path, "app/main.py");
  assert.equal(
    at("  ⎿  Updated docs/protocol.md with 3 additions", "protocol")?.path,
    "docs/protocol.md",
  );
});

test("a quoted path may hold spaces, and a tap inside the quotes takes all of it", () => {
  const text = `open "~/My Files/report 2.pdf" now`;
  assert.equal(at(text, "Files")?.path, "~/My Files/report 2.pdf");
  assert.equal(at(`'src/a b.ts:4'`, "b.ts")?.line, 4);
  // Quoted words that are no path leave the words inside them to be judged one by one.
  assert.deepEqual(only(`"hello world" and 'x/y.md'`), [
    { path: "x/y.md", line: null, column: null },
  ]);
});

test("words, numbers, addresses and a lone ~ are not paths", () => {
  assert.deepEqual(only("version 1.2.3 of the thing, 42 / 7"), []);
  assert.deepEqual(only("https://example.com/a/b and ~ and . and .."), []);
  assert.deepEqual(only("mock ~ % "), []);
  assert.equal(at("cargo build --release", "release"), null);
});

test("paths resolve against the terminal's directory and the Mac's home", () => {
  assert.equal(resolvePath("src/a.ts", "/Users/ege/p", "/Users/ege"), "/Users/ege/p/src/a.ts");
  assert.equal(resolvePath("../b", "/Users/ege/p", null), "/Users/ege/b");
  assert.equal(resolvePath("./c/./d//e", "/w", null), "/w/c/d/e");
  assert.equal(resolvePath("~/n.md", null, "/Users/ege"), "/Users/ege/n.md");
  assert.equal(resolvePath("/x/../y", null, null), "/y");
  assert.equal(resolvePath("src/a.ts", null, "/Users/ege"), null);
  assert.equal(resolvePath("~/n.md", "/w", null), null);
  assert.equal(resolvePath("~other/n.md", "/w", "/Users/ege"), null);
  assert.equal(resolvePath("../../..", "/a", null), null);
});

test("an OSC 8 link to a file names its path, whatever the host", () => {
  assert.equal(
    osc8Uri("id=7;file://eges-mbp.local/Users/ege/a%20b.md"),
    "file://eges-mbp.local/Users/ege/a%20b.md",
  );
  assert.equal(osc8Uri(";"), "");
  assert.equal(fileUrlPath("file://eges-mbp.local/Users/ege/a%20b.md"), "/Users/ege/a b.md");
  assert.equal(fileUrlPath("file:///Users/ege/docs/"), "/Users/ege/docs");
  assert.equal(fileUrlPath("FILE://localhost/tmp/x?y=1#z"), "/tmp/x");
  assert.equal(fileUrlPath("https://example.com/a"), null);
  assert.equal(fileUrlPath("file://host/bad%zz"), null);
});

test("a tap maps to the cell under it at any scale", () => {
  const box = { left: 10, top: 100, width: 800, height: 480 };
  // 80 x 24 cells of 10 x 20 pixels.
  assert.deepEqual(cellAt(10, 100, box, 80, 24), { col: 0, row: 0 });
  assert.deepEqual(cellAt(25, 139.9, box, 80, 24), { col: 1, row: 1 });
  assert.deepEqual(cellAt(809.9, 579.9, box, 80, 24), { col: 79, row: 23 });
  assert.equal(cellAt(9, 300, box, 80, 24), null);
  assert.equal(cellAt(500, 580, box, 80, 24), null);
  // The same grid fitted to a phone (scaled down to 0.45), and pinched up to 1.6 and panned.
  const fitted = { left: 2, top: 60, width: 360, height: 216 };
  assert.deepEqual(cellAt(2 + 4.5 * 41 + 1, 60 + 9 * 12 + 1, fitted, 80, 24), { col: 41, row: 12 });
  const zoomed = { left: -300, top: -50, width: 1280, height: 768 };
  assert.deepEqual(cellAt(-300 + 16 * 50 + 8, -50 + 32 * 20 + 16, zoomed, 80, 24), {
    col: 50,
    row: 20,
  });
});
