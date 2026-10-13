import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../server/db.ts";
import { limiterKey, LOCKOUT_MS, LoginLimiter } from "../server/rate-limit.ts";

function limiterAt(start: number) {
  const clock = { now: start };
  return { clock, limiter: new LoginLimiter(openDatabase(":memory:"), () => clock.now) };
}

test("the fifth failure locks the key for 15 minutes", () => {
  const { clock, limiter } = limiterAt(10_000_000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.deepEqual(limiter.recordFailure("me@example.com"), {
      locked: false,
      remaining: 5 - attempt,
    });
    clock.now += 1000;
  }
  assert.deepEqual(limiter.recordFailure("me@example.com"), {
    locked: true,
    retryAfterMs: LOCKOUT_MS,
  });

  clock.now += LOCKOUT_MS - 1;
  assert.deepEqual(limiter.check("me@example.com"), { locked: true, retryAfterMs: 1 });
  clock.now += 1;
  assert.deepEqual(limiter.check("me@example.com"), { locked: false, remaining: 5 });
});

test("keys are counted separately and a success clears the count", () => {
  const { limiter } = limiterAt(10_000_000);
  for (let attempt = 0; attempt < 5; attempt++) limiter.recordFailure("other@example.com");
  assert.equal(limiter.check("other@example.com").locked, true);
  assert.deepEqual(limiter.check("me@example.com"), { locked: false, remaining: 5 });

  limiter.recordFailure("me@example.com");
  limiter.clear("me@example.com");
  assert.deepEqual(limiter.check("me@example.com"), { locked: false, remaining: 5 });
});

test("failures older than 15 minutes no longer count", () => {
  const { clock, limiter } = limiterAt(10_000_000);
  for (let attempt = 0; attempt < 4; attempt++) limiter.recordFailure("me@example.com");
  clock.now += LOCKOUT_MS;
  assert.deepEqual(limiter.recordFailure("me@example.com"), { locked: false, remaining: 4 });
});

test("the key ignores case and surrounding space", () => {
  assert.equal(limiterKey("  Me@Example.COM "), "me@example.com");
});
