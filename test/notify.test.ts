import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { NotifyGate } from "../server/notify.ts";
import { type NotifyEvent, readNotify } from "../shared/notify.ts";

const WAITING = {
  kind: "agent_waiting",
  title: "Claude Code is waiting",
  body: "Allow Bash: pnpm test?",
  session_id: "sess-1",
  tab_id: "tab-1",
};

test("a notify event is read with its text cleaned and cut to the limits", () => {
  assert.deepEqual(readNotify(WAITING), WAITING);
  assert.deepEqual(
    readNotify({
      ...WAITING,
      title: "  Claude\u001b[1m Code\n is\twaiting \u202e ",
      body: "\r\n one\r\n\r\n\r\n two\u0007 \n",
    }),
    { ...WAITING, title: "Claude [1m Code is waiting", body: "one\n\ntwo" },
  );

  const long = readNotify({ ...WAITING, title: "t".repeat(150), body: "🙂".repeat(400) })!;
  assert.equal(Array.from(long.title).length, 100);
  assert.ok(long.title.endsWith("…"));
  assert.equal(Array.from(long.body).length, 300);
  assert.ok(long.body.startsWith("🙂") && long.body.endsWith("🙂…"));

  assert.equal(readNotify({ ...WAITING, body: undefined })?.body, "");
  assert.equal(readNotify({ ...WAITING, tab_id: undefined })?.tab_id, null);
  assert.equal(readNotify({ ...WAITING, tab_id: 7 })?.tab_id, null);

  assert.equal(readNotify(null), null);
  assert.equal(readNotify({ ...WAITING, kind: "agent_exploded" }), null);
  assert.equal(readNotify({ ...WAITING, title: " \n " }), null);
  assert.equal(readNotify({ ...WAITING, title: 5 }), null);
  assert.equal(readNotify({ ...WAITING, session_id: "" }), null);
  assert.equal(readNotify({ ...WAITING, session_id: "s".repeat(256) }), null);
});

function gate(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const out: NotifyEvent[] = [];
  const logs: string[] = [];
  const notifyGate = new NotifyGate({
    deliver: (item) => out.push(item),
    log: (line) => logs.push(line),
  });
  const titles = () => out.map((item) => `${item.kind}: ${item.title}`);
  return { notifyGate, out, logs, titles, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("the first notification of a session and kind goes out at once, a repeat does not", (t) => {
  const { notifyGate, out, tick } = gate(t);
  notifyGate.accept(WAITING);
  assert.equal(out.length, 1);

  for (let i = 0; i < 5; i++) {
    tick(500);
    notifyGate.accept(WAITING);
  }
  tick(10_000);
  assert.equal(out.length, 1, "the same words within five seconds are dropped for good");

  notifyGate.accept(WAITING);
  assert.equal(out.length, 2, "after five seconds the same words go out again");
});

test("new words within five seconds wait, and only the newest of them goes out", (t) => {
  const { notifyGate, titles, tick } = gate(t);
  notifyGate.accept(WAITING);
  tick(1_000);
  notifyGate.accept({ ...WAITING, title: "second" });
  tick(1_000);
  notifyGate.accept({ ...WAITING, title: "third" });
  tick(2_999);
  assert.deepEqual(titles(), ["agent_waiting: Claude Code is waiting"]);
  tick(1);
  assert.deepEqual(titles(), ["agent_waiting: Claude Code is waiting", "agent_waiting: third"]);

  // What went out late starts five quiet seconds of its own.
  tick(4_000);
  notifyGate.accept({ ...WAITING, title: "fourth" });
  assert.equal(titles().length, 2);
  tick(1_000);
  assert.equal(titles().at(-1), "agent_waiting: fourth");
});

test("another kind, and another session, are not held back, and what waited is dropped", (t) => {
  const { notifyGate, titles, tick } = gate(t);
  notifyGate.accept(WAITING);
  notifyGate.accept({ ...WAITING, session_id: "sess-2" });
  tick(1_000);
  notifyGate.accept({ ...WAITING, title: "a newer question" });
  tick(1_000);
  notifyGate.accept({ ...WAITING, kind: "agent_done", title: "Claude Code finished" });
  tick(10_000);
  assert.deepEqual(titles(), [
    "agent_waiting: Claude Code is waiting",
    "agent_waiting: Claude Code is waiting",
    "agent_done: Claude Code finished",
  ]);
});

test("a burst from every terminal at once stops at twenty a minute", (t) => {
  const { notifyGate, out, logs, tick } = gate(t);
  for (let i = 0; i < 30; i++) notifyGate.accept({ ...WAITING, session_id: `sess-${i}` });
  assert.equal(out.length, 20);
  assert.match(logs.join("\n"), /over 20 a minute/);
  tick(60_000);
  notifyGate.accept({ ...WAITING, session_id: "sess-late" });
  assert.equal(out.length, 21);
});

test("a malformed notify is dropped and said so, and a failing delivery does not throw", (t) => {
  const { notifyGate, out, logs } = gate(t);
  notifyGate.accept({ kind: "agent_waiting" });
  notifyGate.accept("nonsense");
  assert.equal(out.length, 0);
  assert.equal(logs.length, 2);

  const failing = new NotifyGate({
    deliver: () => {
      throw new Error("no route");
    },
    log: (line) => logs.push(line),
  });
  failing.accept(WAITING);
  assert.match(logs.at(-1)!, /no route/);
});
