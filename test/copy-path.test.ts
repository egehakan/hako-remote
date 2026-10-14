import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsRoot } from "../shared/protocol.ts";
import { relativePathFor, shortenMiddle } from "../src/lib/files/copy-path.ts";

const HOME = "/Users/ege";
const ROOTS: FsRoot[] = [
  { path: "/Users/ege/code/hako", name: "hako", source: "folder" },
  { path: "/Users/ege/code/hako/crates/ui", name: "ui", source: "folder" },
  { path: HOME, name: "Home", source: "home" },
  { path: "/tmp/build", name: "build", source: "terminal" },
];

test("a path is relative to the deepest root that holds it, and a root is `.`", () => {
  assert.equal(relativePathFor("/Users/ege/code/hako/app/main.rs", ROOTS, HOME), "app/main.rs");
  assert.equal(
    relativePathFor("/Users/ege/code/hako/crates/ui/src/lib.rs", ROOTS, HOME),
    "src/lib.rs",
  );
  assert.equal(relativePathFor("/Users/ege/code/hako/crates", ROOTS, HOME), "crates");
  assert.equal(relativePathFor("/Users/ege/code/hako", ROOTS, HOME), ".");
  assert.equal(relativePathFor("/Users/ege/code/hako/crates/ui", ROOTS, HOME), ".");
  assert.equal(relativePathFor("/tmp/build/out/a.o", ROOTS, HOME), "out/a.o");
  // A name that only starts like a root is not in it.
  assert.equal(relativePathFor("/Users/ege/code/hakoish/x", ROOTS, HOME), "code/hakoish/x");
});

test("a folder or terminal root wins over the home root, which holds what nothing else does", () => {
  const roots: FsRoot[] = [
    { path: HOME, name: "Home", source: "home" },
    { path: "/Users/ege/notes", name: "notes", source: "terminal" },
  ];
  assert.equal(relativePathFor("/Users/ege/notes/today.md", roots, HOME), "today.md");
  assert.equal(relativePathFor("/Users/ege/Downloads/a b.pdf", roots, HOME), "Downloads/a b.pdf");
  assert.equal(relativePathFor(HOME, roots, HOME), ".");
});

test("outside every root a path is ~/… under home, and absolute elsewhere", () => {
  const roots = ROOTS.filter((root) => root.source !== "home");
  assert.equal(
    relativePathFor("/Users/ege/My Files/report 2.pdf", roots, HOME),
    "~/My Files/report 2.pdf",
  );
  assert.equal(relativePathFor(HOME, roots, HOME), "~");
  assert.equal(relativePathFor("/etc/hosts", roots, HOME), "/etc/hosts");
  assert.equal(relativePathFor("/Users/ege/x", [], null), "/Users/ege/x");
  // A root at `/` holds everything.
  assert.equal(
    relativePathFor("/etc/hosts", [{ path: "/", name: "/", source: "terminal" }], HOME),
    "etc/hosts",
  );
});

test("a long path is shortened in the middle", () => {
  assert.equal(shortenMiddle("src/a.ts", 20), "src/a.ts");
  const short = shortenMiddle("/Users/ege/code/hako/crates/ui/src/lib.rs", 20);
  assert.equal([...short].length, 20);
  assert.ok(short.startsWith("/Users/ege") && short.endsWith("/lib.rs") && short.includes("…"));
});
