import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBranchName, localNameOf } from "../src/lib/git/branches.ts";

const accepted = (name: string, taken: string[] = []) => checkBranchName(name, taken).ok;

test("ordinary branch names are accepted, trimmed of the spaces a phone's keyboard adds", () => {
  for (const name of [
    "main",
    "feature/dark-mode",
    "fix/title-typo",
    "release/1.0",
    "wip_2",
    "a",
    "user@host",
    "émile/ünïcode",
    "v1.2.3-rc.1",
  ]) {
    assert.equal(accepted(name), true, name);
  }
  assert.deepEqual(checkBranchName("  try/new-idea "), { ok: true, name: "try/new-idea" });
});

test("names git would refuse are refused, each for its reason", () => {
  for (const name of [
    "",
    "   ",
    "two words",
    "-f",
    "--force",
    "a..b",
    "a~1",
    "a^",
    "a:b",
    "what?",
    "star*",
    "open[",
    "back\\slash",
    "/lead",
    "trail/",
    "double//slash",
    "ends.",
    ".hidden",
    "dir/.hidden",
    "name.lock",
    "dir.lock/name",
    "@",
    "HEAD",
    "a@{b",
    "@{-1}",
    "tab\there",
    "bell\u0007",
    "del\u007f",
  ]) {
    const check = checkBranchName(name);
    assert.equal(check.ok, false, JSON.stringify(name));
    if (!check.ok) assert.notEqual(check.reason, "");
  }
});

test("a name that is taken is refused, but only by a local branch of exactly that name", () => {
  assert.equal(accepted("main", ["main", "redesign"]), false);
  assert.equal(accepted("Main", ["main"]), true);
  assert.equal(accepted("mainline", ["main"]), true);
});

test("a name that would sit inside another branch's, or hold it, is refused", () => {
  assert.equal(accepted("main/next", ["main"]), false);
  assert.equal(accepted("feature", ["feature/dark-mode"]), false);
  assert.equal(accepted("feature/light-mode", ["feature/dark-mode"]), true);
});

test("a remote branch's local name drops the remote, and only the remote", () => {
  assert.equal(localNameOf("origin/main"), "main");
  assert.equal(localNameOf("origin/feature/contact-form"), "feature/contact-form");
  assert.equal(localNameOf("upstream/fix"), "fix");
});
