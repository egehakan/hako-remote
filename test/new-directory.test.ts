import assert from "node:assert/strict";
import { test } from "node:test";
import { nameProblem } from "../shared/files.ts";
import { checkDirectoryName } from "../src/lib/files/new-directory.ts";

test("a name is one segment of a path, of 1 to 255 bytes", () => {
  for (const name of [
    "a",
    "my project",
    ".config",
    "...",
    "a..b",
    "x".repeat(255),
    "é".repeat(127),
  ]) {
    assert.equal(nameProblem(name), null, name);
  }
  assert.equal(nameProblem(""), "empty");
  assert.equal(nameProblem("."), "reserved");
  assert.equal(nameProblem(".."), "reserved");
  assert.equal(nameProblem("a/b"), "slash");
  assert.equal(nameProblem("/"), "slash");
  assert.equal(nameProblem("a\0b"), "nul");
  assert.equal(nameProblem("x".repeat(256)), "too_long");
});

test("the limit counts bytes, not characters", () => {
  assert.equal(nameProblem("é".repeat(127)), null);
  assert.equal(nameProblem("é".repeat(128)), "too_long");
  assert.equal(nameProblem("📦".repeat(63)), null);
  assert.equal(nameProblem("📦".repeat(64)), "too_long");
});

test("a typed name loses the spaces at its ends and nothing else", () => {
  assert.deepEqual(checkDirectoryName("  notes "), { ok: true, name: "notes" });
  assert.deepEqual(checkDirectoryName("my project"), { ok: true, name: "my project" });
  assert.deepEqual(checkDirectoryName(".config"), { ok: true, name: ".config" });
  assert.deepEqual(checkDirectoryName("Büro 📦"), { ok: true, name: "Büro 📦" });
});

test("a name the Mac would refuse is refused with a reason", () => {
  for (const typed of ["", "   ", ".", "..", " .. ", "a/b", "/", "a\0b", "x".repeat(256)]) {
    const check = checkDirectoryName(typed);
    assert.equal(check.ok, false, JSON.stringify(typed));
    assert.ok(!check.ok && check.reason.length > 0);
  }
  const long = checkDirectoryName("é".repeat(128));
  assert.ok(!long.ok && long.reason.includes("256 bytes"));
});

test("a name that is already in the directory is refused, letter for letter", () => {
  const siblings = ["docs", "README.md"];
  assert.equal(checkDirectoryName("docs", siblings).ok, false);
  assert.equal(checkDirectoryName(" docs ", siblings).ok, false);
  assert.equal(checkDirectoryName("README.md", siblings).ok, false);
  // Whether "Docs" collides with "docs" depends on the Mac's file system, so the Mac decides.
  assert.deepEqual(checkDirectoryName("Docs", siblings), { ok: true, name: "Docs" });
});
