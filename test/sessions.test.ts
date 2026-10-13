import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../server/db.ts";
import {
  hashSessionId,
  SESSION_TTL_MS,
  SessionStore,
  signSessionId,
  unsignSessionId,
} from "../server/sessions.ts";

const SECRET = "a-test-secret-that-is-long-enough";

test("a signed session id round-trips and any tampering is rejected", () => {
  const cookie = signSessionId("abc123", SECRET);
  assert.equal(unsignSessionId(cookie, SECRET), "abc123");
  assert.equal(unsignSessionId(cookie, "another-secret-of-similar-length"), null);
  assert.equal(unsignSessionId(cookie.replace("abc123", "abc124"), SECRET), null);
  assert.equal(unsignSessionId(`${cookie}x`, SECRET), null);
  assert.equal(unsignSessionId("abc123", SECRET), null);
  assert.equal(unsignSessionId("abc123.", SECRET), null);
  assert.equal(unsignSessionId("", SECRET), null);
});

test("the database stores a hash, not the session id", () => {
  const db = openDatabase(":memory:");
  const store = new SessionStore(db, SECRET);
  const { cookie, idHash } = store.create();
  const id = unsignSessionId(cookie, SECRET);
  assert.ok(id);
  const rows = db.prepare("SELECT id_hash FROM sessions").all();
  assert.deepEqual(
    rows.map((row) => row.id_hash),
    [hashSessionId(id)],
  );
  assert.notEqual(idHash, id);
  assert.equal(store.resolve(cookie), idHash);
});

test("a session ends after 30 days, on delete, and when other sessions are ended", () => {
  let now = 1_000_000;
  const store = new SessionStore(openDatabase(":memory:"), SECRET, () => now);
  const first = store.create();
  const second = store.create();

  assert.deepEqual(store.deleteOthers(second.idHash), [first.idHash]);
  assert.equal(store.resolve(first.cookie), null);
  assert.equal(store.resolve(second.cookie), second.idHash);

  now += SESSION_TTL_MS - 1;
  assert.equal(store.resolve(second.cookie), second.idHash);
  now += 1;
  assert.equal(store.resolve(second.cookie), null);

  const third = store.create();
  store.delete(third.idHash);
  assert.equal(store.resolve(third.cookie), null);
});

test("a cookie signed with the right secret but unknown to the database is refused", () => {
  const store = new SessionStore(openDatabase(":memory:"), SECRET);
  assert.equal(store.resolve(signSessionId("never-issued", SECRET)), null);
  assert.equal(store.resolve(undefined), null);
});
