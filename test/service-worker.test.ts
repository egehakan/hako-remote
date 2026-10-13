import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// The service worker is run here as it is served, against stand-ins for what a browser gives it.

type Shown = { title: string; options: Record<string, any> };
type FakeClient = {
  focused: boolean;
  visibilityState: string;
  messages: unknown[];
  focusCount: number;
  postMessage(message: unknown): void;
  focus(): Promise<void>;
};

/** Objects made inside the worker's own context, as ones made here. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const SOURCE = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function worker(windows: Partial<FakeClient>[] = []) {
  const handlers = new Map<string, (event: any) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const clients: FakeClient[] = windows.map((given) => ({
    focused: false,
    visibilityState: "hidden",
    messages: [],
    focusCount: 0,
    postMessage(message) {
      this.messages.push(plain(message));
    },
    async focus() {
      this.focusCount += 1;
    },
    ...given,
  }));
  let skippedWaiting = false;
  let claimed = false;
  const self = {
    addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
    skipWaiting: () => {
      skippedWaiting = true;
    },
    registration: {
      showNotification: async (title: string, options: Record<string, any>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {
        claimed = true;
      },
      matchAll: async () => clients,
      openWindow: async (address: string) => {
        opened.push(address);
      },
    },
  };
  vm.runInNewContext(SOURCE, { self, Date, encodeURIComponent });

  /** Runs one event to its end, as the browser waits for what `waitUntil` was given. */
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)?.({ waitUntil: (work: Promise<unknown>) => waits.push(work), ...event });
    await Promise.all(waits);
  };
  const push = (payload: unknown) =>
    dispatch("push", {
      data:
        payload === undefined
          ? null
          : { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) },
    });
  const click = (data: unknown) => {
    let closed = false;
    return dispatch("notificationclick", {
      notification: { data, close: () => (closed = true) },
    }).then(() => closed);
  };
  const message = (data: unknown) => {
    const replies: unknown[] = [];
    handlers.get("message")?.({
      data,
      source: { postMessage: (reply: unknown) => replies.push(plain(reply)) },
    });
    return replies;
  };
  return {
    handlers,
    shown,
    opened,
    clients,
    dispatch,
    push,
    click,
    message,
    get skippedWaiting() {
      return skippedWaiting;
    },
    get claimed() {
      return claimed;
    },
  };
}

const PAYLOAD = {
  v: 1,
  kind: "agent_waiting",
  title: "Claude Code needs your permission",
  body: "Allow Bash: pnpm test?",
  session_id: "sess 7/a",
  tab_id: "tab-3",
  tag: "hako:sess 7/a",
};

test("the worker answers no request, and a new version takes over at once", async () => {
  const sw = worker();
  assert.equal(sw.handlers.has("fetch"), false);
  assert.ok(!/\bcaches\b/.test(SOURCE), "nothing is put in a cache");
  await sw.dispatch("install");
  await sw.dispatch("activate");
  assert.ok(sw.skippedWaiting);
  assert.ok(sw.claimed);
});

test("a push shows a notification with its terminal's tag", async () => {
  const sw = worker();
  await sw.push(PAYLOAD);
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "Claude Code needs your permission");
  assert.equal(sw.shown[0].options.body, "Allow Bash: pnpm test?");
  assert.equal(sw.shown[0].options.tag, "hako:sess 7/a");
  assert.deepEqual(plain(sw.shown[0].options.data), {
    kind: "agent_waiting",
    session_id: "sess 7/a",
    tab_id: "tab-3",
  });
});

test("a push the worker cannot read still shows a notification", async () => {
  const sw = worker();
  await sw.push(undefined);
  await sw.push("{ not json");
  await sw.push({ body: "no title" });
  assert.equal(sw.shown.length, 3);
  for (const { title, options } of sw.shown) {
    assert.equal(title, "Hako");
    assert.ok(options.body.length > 0);
    assert.ok(options.tag.length > 0);
    assert.equal(options.data.session_id, null);
  }
});

test("a tap with the app open focuses it and tells it which terminal to show", async () => {
  const sw = worker([{}, { visibilityState: "visible" }, { focused: true }]);
  assert.equal(await sw.click({ session_id: "sess 7/a", tab_id: "tab-3" }), true);
  const [background, visible, focused] = sw.clients;
  assert.deepEqual(focused.messages, [
    { type: "hako:open", target: { session_id: "sess 7/a", tab_id: "tab-3" } },
  ]);
  assert.equal(focused.focusCount, 1);
  assert.deepEqual([background.messages, visible.messages], [[], []]);
  assert.deepEqual(sw.opened, []);

  // A window that may not be focused has been told all the same.
  const refusing = worker([
    {
      focus: async () => {
        throw new Error("not allowed");
      },
    },
  ]);
  await refusing.click({ session_id: "s1", tab_id: null });
  assert.equal(refusing.clients[0].messages.length, 1);
});

test("a tap with the app closed opens it at the terminal's address", async () => {
  const sw = worker();
  await sw.click({ session_id: "sess 7/a", tab_id: "tab-3" });
  assert.deepEqual(sw.opened, ["/#/t/sess%207%2Fa"]);

  // A test notification is about no terminal: the app just opens.
  const test = worker();
  await test.click({ kind: "test", session_id: null, tab_id: null });
  assert.deepEqual(test.opened, ["/"]);
  const open = worker([{ focused: true }]);
  await open.click({ kind: "test", session_id: null });
  assert.equal(open.clients[0].focusCount, 1);
  assert.deepEqual(open.clients[0].messages, []);
});

test("the tapped terminal is kept once for a page that asks, and dropped when a page took it", async () => {
  const sw = worker();
  assert.deepEqual(sw.message({ type: "hako:pending" }), []);
  await sw.click({ session_id: "s1", tab_id: "t1" });
  assert.deepEqual(sw.message({ type: "hako:pending" }), [
    { type: "hako:open", target: { session_id: "s1", tab_id: "t1" } },
  ]);
  assert.deepEqual(sw.message({ type: "hako:pending" }), []);

  await sw.click({ session_id: "s2", tab_id: null });
  sw.message({ type: "hako:taken" });
  assert.deepEqual(sw.message({ type: "hako:pending" }), []);
});
