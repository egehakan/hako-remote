import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, passwordProblem, verifyPassword } from "../server/password.ts";

test("a password verifies against its own hash and nothing else", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("correct horse batterz", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("each hash gets its own salt", async () => {
  const [first, second] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same password", second), true);
});

test("a malformed stored hash never verifies", async () => {
  for (const stored of ["", "plain", "scrypt$1$2", "bcrypt$a$b$c$d$e", "scrypt$x$8$1$AAAA$AAAA"]) {
    assert.equal(await verifyPassword("anything at all", stored), false);
  }
});

test("new passwords must be between 10 and 256 characters", () => {
  assert.notEqual(passwordProblem("short"), null);
  assert.notEqual(passwordProblem("x".repeat(257)), null);
  assert.notEqual(passwordProblem(undefined), null);
  assert.equal(passwordProblem("long enough"), null);
});
