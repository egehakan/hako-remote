import assert from "node:assert/strict";
import { test } from "node:test";
import { compareEntries, imageMime, isValidPath } from "../shared/files.ts";
import type { FsEntry } from "../shared/protocol.ts";
import {
  baseName,
  crumbsFor,
  decodePath,
  encodePath,
  isWithin,
  joinPath,
  parentOf,
  resolveRelative,
  rootFor,
} from "../src/lib/files/paths.ts";

test("only absolute, normalised paths are valid", () => {
  for (const path of ["/", "/a", "/Users/ege/My Files/a.txt", "/a/.git", "/a/..b"]) {
    assert.equal(isValidPath(path), true, path);
  }
  for (const path of ["", "a/b", "~", "~/x", "/a/", "/a//b", "/a/./b", "/a/../b", "/..", 7, null]) {
    assert.equal(isValidPath(path), false, String(path));
  }
});

test("joining and splitting treat the root directory as a directory like any other", () => {
  assert.equal(joinPath("/", "etc"), "/etc");
  assert.equal(joinPath("/a/b", "c.txt"), "/a/b/c.txt");
  assert.equal(parentOf("/a/b/c.txt"), "/a/b");
  assert.equal(parentOf("/etc"), "/");
  assert.equal(parentOf("/"), null);
  assert.equal(baseName("/a/b/c.txt"), "c.txt");
  assert.equal(baseName("/"), "/");
});

test("a directory holds itself and what is below it, but not its namesakes", () => {
  assert.equal(isWithin("/a/hako", "/a/hako"), true);
  assert.equal(isWithin("/a/hako", "/a/hako/src"), true);
  assert.equal(isWithin("/a/hako", "/a/hako-remote"), false);
  assert.equal(isWithin("/", "/anything"), true);
});

test("a path belongs to the deepest root that holds it", () => {
  const roots = [{ path: "/Users/ege" }, { path: "/Users/ege/code/hako" }, { path: "/tmp" }];
  assert.equal(rootFor("/Users/ege/code/hako/src", roots)?.path, "/Users/ege/code/hako");
  assert.equal(rootFor("/Users/ege/code/hako-remote", roots)?.path, "/Users/ege");
  assert.equal(rootFor("/var/log", roots), null);
});

test("crumbs lead from the root's name down to the directory", () => {
  const root = { path: "/Users/ege/code/hako", name: "Hako" };
  assert.deepEqual(crumbsFor("/Users/ege/code/hako/app/src", root), [
    { name: "Hako", path: "/Users/ege/code/hako" },
    { name: "app", path: "/Users/ege/code/hako/app" },
    { name: "src", path: "/Users/ege/code/hako/app/src" },
  ]);
  assert.deepEqual(crumbsFor("/Users/ege/code/hako", root), [
    { name: "Hako", path: "/Users/ege/code/hako" },
  ]);
  assert.deepEqual(crumbsFor("/etc/ssh", null), [
    { name: "/", path: "/" },
    { name: "etc", path: "/etc" },
    { name: "ssh", path: "/etc/ssh" },
  ]);
});

test("a path survives the address bar, whatever is in its names", () => {
  for (const path of ["/", "/a/b", "/Users/ege/My Files/50% #1?.txt", "/a/ü/日本語", "/a/%2F"]) {
    assert.equal(decodePath(encodePath(path)), path);
  }
  assert.equal(encodePath("/a b/c#d"), "/a%20b/c%23d");
});

test("an address that does not hold a valid path is refused", () => {
  assert.equal(decodePath("/a/../b"), null);
  assert.equal(decodePath("/a/%2E%2E/b"), null);
  assert.equal(decodePath("/a%2Fb"), null);
  assert.equal(decodePath("/a/%E0%A4%A"), null);
  assert.equal(decodePath("a/b"), null);
  assert.equal(decodePath("/a/"), null);
});

test("relative links in a document resolve against its directory", () => {
  assert.equal(resolveRelative("/p/docs", "protocol.md"), "/p/docs/protocol.md");
  assert.equal(resolveRelative("/p/docs", "./images/a%20b.png"), "/p/docs/images/a b.png");
  assert.equal(resolveRelative("/p/docs", "../README.md#run"), "/p/README.md");
  assert.equal(resolveRelative("/", "a.md"), "/a.md");
  assert.equal(resolveRelative("/p", "../../x"), null);
  for (const href of [
    "https://example.com/a",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "#top",
    "/abs",
    "",
  ]) {
    assert.equal(resolveRelative("/p/docs", href), null, href);
  }
});

test("images are told by their extension, in any case", () => {
  assert.equal(imageMime("/a/Photo.JPG"), "image/jpeg");
  assert.equal(imageMime("/a/b.jpeg"), "image/jpeg");
  assert.equal(imageMime("/a/mark.svg"), "image/svg+xml");
  assert.equal(imageMime("/a/x.webp"), "image/webp");
  assert.equal(imageMime("/a/png"), null);
  assert.equal(imageMime("/a.png/readme"), null);
  assert.equal(imageMime("/a/b.txt"), null);
});

test("listings put directories first, then order by name without regard to case", () => {
  const entry = (
    name: string,
    kind: FsEntry["kind"],
    target: FsEntry["target"] = null,
  ): FsEntry => ({
    name,
    kind,
    target,
    size: 0,
    mtime: 0,
  });
  const sorted = [
    entry("b.txt", "file"),
    entry("Zeta", "dir"),
    entry("a.txt", "file"),
    entry("link", "symlink", "dir"),
    entry("B.txt", "file"),
    entry("alpha", "dir"),
    entry("dangling", "symlink"),
  ].sort(compareEntries);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["alpha", "link", "Zeta", "a.txt", "B.txt", "b.txt", "dangling"],
  );
});
