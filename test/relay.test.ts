import assert from "node:assert/strict";
import { test } from "node:test";
import { Relay, type RelaySocket, requestTimeout } from "../server/relay.ts";
import { encodeOutputFrame } from "../shared/frames.ts";

type Sent = Record<string, any>;

class FakeSocket implements RelaySocket {
  readonly frames: (string | Uint8Array)[] = [];
  closedWith: number | null = null;

  send(data: string | Uint8Array): void {
    this.frames.push(data);
  }

  close(code: number): void {
    this.closedWith = code;
  }

  get json(): Sent[] {
    return this.frames
      .filter((frame) => typeof frame === "string")
      .map((frame) => JSON.parse(frame));
  }

  get binary(): Uint8Array[] {
    return this.frames.filter((frame) => typeof frame !== "string");
  }

  last(): Sent {
    return this.json.at(-1)!;
  }
}

/** A relay with an agent that has already answered `app.info`. */
function setup(options = {}) {
  const relay = new Relay(options);
  const agent = new FakeSocket();
  relay.attachAgent(agent);
  const info = agent.last();
  relay.handleAgentMessage(
    agent,
    JSON.stringify({
      t: "res",
      id: info.id,
      ok: true,
      result: { name: "Studio", version: "1.2", hostname: "studio.local" },
    }),
  );
  const connect = () => {
    const socket = new FakeSocket();
    const id = relay.addClient(socket, `session-of-${socket.frames.length}`);
    return { socket, id };
  };
  return { relay, agent, connect };
}

function request(relay: Relay, clientId: string, id: string, method: string, params: object = {}) {
  relay.handleClientMessage(clientId, JSON.stringify({ t: "req", id, method, params }));
}

function answer(relay: Relay, agent: FakeSocket, forwarded: Sent, result: object = {}) {
  relay.handleAgentMessage(agent, JSON.stringify({ t: "res", id: forwarded.id, ok: true, result }));
}

test("a new client is told the agent's status", () => {
  const { connect } = setup();
  const { socket } = connect();
  assert.deepEqual(socket.json, [
    {
      t: "evt",
      event: "agent.status",
      data: { online: true, name: "Studio", version: "1.2", hostname: "studio.local" },
    },
  ]);
});

test("the same client id from two connections reaches the agent as two ids and each gets its own answer", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const b = connect();
  request(relay, a.id, "7", "workspace.list");
  request(relay, b.id, "7", "some.future.method", { anything: true });

  const [toAgentA, toAgentB] = agent.json.slice(-2);
  assert.equal(toAgentA.id, `${a.id}:7`);
  assert.equal(toAgentB.id, `${b.id}:7`);
  assert.equal(toAgentB.method, "some.future.method");
  assert.deepEqual(toAgentB.params, { anything: true });

  answer(relay, agent, toAgentB, { from: "b" });
  answer(relay, agent, toAgentA, { from: "a" });
  assert.deepEqual(a.socket.last(), { t: "res", id: "7", ok: true, result: { from: "a" } });
  assert.deepEqual(b.socket.last(), { t: "res", id: "7", ok: true, result: { from: "b" } });
  assert.equal(a.socket.json.length, 2);
});

test("a client id that contains a colon is restored exactly", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  request(relay, a.id, "tab:3:close", "tab.close", { tab_id: "t" });
  answer(relay, agent, agent.last());
  assert.equal(a.socket.last().id, "tab:3:close");
});

test("an answer nobody is waiting for is dropped, including one aimed at another client's id", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const before = a.socket.json.length;
  relay.handleAgentMessage(
    agent,
    JSON.stringify({ t: "res", id: `${a.id}:99`, ok: true, result: {} }),
  );
  relay.handleAgentMessage(agent, JSON.stringify({ t: "res", id: "99", ok: true, result: {} }));
  assert.equal(a.socket.json.length, before);
});

test("requests fail at once with agent_offline when there is no agent, and when it drops mid-request", () => {
  const relay = new Relay();
  const socket = new FakeSocket();
  const id = relay.addClient(socket, "s");
  assert.deepEqual(socket.last().data, { online: false });
  request(relay, id, "1", "workspace.list");
  assert.equal(socket.last().error.code, "agent_offline");

  const agent = new FakeSocket();
  relay.attachAgent(agent);
  answer(relay, agent, agent.last(), { name: "Studio" });
  assert.deepEqual(socket.last().data, { online: true, name: "Studio" });
  request(relay, id, "2", "workspace.list");
  relay.detachAgent(agent);
  const [failed, status] = socket.json.slice(-2);
  assert.deepEqual([failed.id, failed.error.code], ["2", "agent_offline"]);
  assert.deepEqual(status.data, { online: false });
});

test("a request the agent does not answer times out after 20 seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { relay, agent, connect } = setup();
  const a = connect();
  request(relay, a.id, "1", "workspace.list");
  const forwarded = agent.last();
  t.mock.timers.tick(19_999);
  assert.equal(a.socket.json.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual([a.socket.last().id, a.socket.last().error.code], ["1", "timeout"]);

  answer(relay, agent, forwarded);
  assert.equal(a.socket.json.length, 2);
});

test("malformed requests get bad_request and never reach the agent", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const before = agent.json.length;
  relay.handleClientMessage(a.id, JSON.stringify({ t: "req", id: "1" }));
  assert.equal(a.socket.last().error.code, "bad_request");
  relay.handleClientMessage(a.id, "not json");
  relay.handleClientMessage(a.id, JSON.stringify({ t: "res", id: "1", ok: true, result: {} }));
  request(relay, a.id, "2", "workspace.list");
  request(relay, a.id, "2", "workspace.list");
  assert.equal(a.socket.last().error.code, "bad_request");
  assert.equal(agent.json.length, before + 1);
});

test("a new agent replaces the old one, which is closed with 4001", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const second = new FakeSocket();
  relay.attachAgent(second);
  assert.equal(agent.closedWith, 4001);
  assert.deepEqual(a.socket.last().data, { online: false });

  // A late frame from the replaced agent is ignored.
  relay.handleAgentMessage(
    agent,
    JSON.stringify({ t: "evt", event: "workspace.changed", data: {} }),
  );
  assert.deepEqual(a.socket.last().data, { online: false });
  relay.detachAgent(agent);

  answer(relay, second, second.last(), { name: "Second" });
  assert.deepEqual(a.socket.last().data, { online: true, name: "Second" });
});

test("the agent is announced without a name when it never answers app.info", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const relay = new Relay();
  const socket = new FakeSocket();
  relay.addClient(socket, "s");
  relay.attachAgent(new FakeSocket());
  assert.equal(socket.json.length, 1);
  t.mock.timers.tick(5000);
  assert.deepEqual(socket.last().data, { online: true });
});

test("general events go to every client; notifications go to the agent", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const b = connect();
  relay.handleAgentMessage(
    agent,
    JSON.stringify({ t: "evt", event: "workspace.changed", data: {} }),
  );
  assert.equal(a.socket.last().event, "workspace.changed");
  assert.equal(b.socket.last().event, "workspace.changed");

  relay.handleClientMessage(
    a.id,
    JSON.stringify({ t: "ntf", method: "term.input", params: { session_id: "s1", data: "ls\r" } }),
  );
  assert.deepEqual(agent.last(), {
    t: "ntf",
    method: "term.input",
    params: { session_id: "s1", data: "ls\r" },
  });
});

test("terminal output and terminal events reach only the clients subscribed to that session", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const b = connect();
  const c = connect();
  const subscribe = (client: { id: string }, session: string) => {
    request(relay, client.id, "sub", "term.subscribe", { session_id: session });
    answer(relay, agent, agent.last(), { cols: 80, rows: 24, seq: 0, snapshot: "" });
  };
  subscribe(a, "s1");
  subscribe(b, "s1");
  subscribe(b, "s2");

  const frame = encodeOutputFrame("s1", 42, new Uint8Array([104, 105]));
  relay.handleAgentMessage(agent, frame);
  relay.handleAgentMessage(agent, encodeOutputFrame("s2", 0, new Uint8Array([33])));
  assert.deepEqual(a.socket.binary, [frame]);
  assert.equal(b.socket.binary.length, 2);
  assert.equal(c.socket.binary.length, 0);

  relay.handleAgentMessage(
    agent,
    JSON.stringify({
      t: "evt",
      event: "term.size",
      data: { session_id: "s2", cols: 40, rows: 20 },
    }),
  );
  assert.equal(b.socket.last().event, "term.size");
  assert.notEqual(a.socket.last().event, "term.size");
  assert.notEqual(c.socket.last().event, "term.size");
});

test("the agent hears term.unsubscribe only when the last subscriber leaves", () => {
  const { relay, agent, connect } = setup();
  const a = connect();
  const b = connect();
  for (const client of [a, b]) {
    request(relay, client.id, "sub", "term.subscribe", { session_id: "s1" });
    answer(relay, agent, agent.last(), { cols: 80, rows: 24, seq: 0, snapshot: "" });
  }
  const sentToAgent = () => agent.json.filter((frame) => frame.method === "term.unsubscribe");

  request(relay, a.id, "u", "term.unsubscribe", { session_id: "s1" });
  assert.deepEqual(a.socket.last(), { t: "res", id: "u", ok: true, result: {} });
  assert.equal(sentToAgent().length, 0);

  relay.removeClient(b.id);
  assert.equal(sentToAgent().length, 1);
  assert.deepEqual(sentToAgent()[0].params, { session_id: "s1" });
  assert.match(sentToAgent()[0].id, /^relay:/);

  relay.handleAgentMessage(agent, encodeOutputFrame("s1", 0, new Uint8Array([1])));
  assert.equal(a.socket.binary.length, 0);
});

test("output for a session nobody watches makes the relay stop the stream once", () => {
  const { relay, agent } = setup();
  const before = agent.json.length;
  relay.handleAgentMessage(agent, encodeOutputFrame("ghost", 0, new Uint8Array([1])));
  relay.handleAgentMessage(agent, encodeOutputFrame("ghost", 1, new Uint8Array([2])));
  const sent = agent.json.slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].method, sent[0].params], ["term.unsubscribe", { session_id: "ghost" }]);
});

test("ending a login session closes its sockets with 4401 and leaves the others open", () => {
  const relay = new Relay();
  const mine = new FakeSocket();
  const other = new FakeSocket();
  relay.addClient(mine, "hash-1");
  relay.addClient(other, "hash-2");
  relay.closeSessions(["hash-1"]);
  assert.equal(mine.closedWith, 4401);
  assert.equal(other.closedWith, null);
  assert.equal(relay.clientCount, 1);
});

test("a request may ask for more time than the default, and then outlasts it", async () => {
  const { relay, agent, connect } = setup({ requestTimeoutMs: 20 });
  const { socket, id } = connect();
  request(relay, id, "1", "workspace.list");
  relay.handleClientMessage(
    id,
    JSON.stringify({ t: "req", id: "2", method: "git.push", params: {}, timeout_ms: 5_000 }),
  );
  const forwarded = agent.json.find((frame) => frame.method === "git.push")!;
  // The agent is not told how long the client is willing to wait.
  assert.equal("timeout_ms" in forwarded, false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const timedOut = socket.json.filter((frame) => frame.t === "res");
  assert.deepEqual(
    timedOut.map((frame) => [frame.id, frame.error?.code]),
    [["1", "timeout"]],
  );

  answer(relay, agent, forwarded, { output: "done" });
  assert.deepEqual(socket.last(), { t: "res", id: "2", ok: true, result: { output: "done" } });
});

test("the time a request asks for is kept within the relay's limits", () => {
  assert.equal(requestTimeout(undefined, 20_000), 20_000);
  assert.equal(requestTimeout("300000", 20_000), 20_000);
  assert.equal(requestTimeout(Number.NaN, 20_000), 20_000);
  assert.equal(requestTimeout(300_000.7, 20_000), 300_000);
  assert.equal(requestTimeout(5, 20_000), 1_000);
  assert.equal(requestTimeout(-1, 20_000), 1_000);
  assert.equal(requestTimeout(86_400_000, 20_000), 600_000);
});

test("a notify event goes to whoever decides about notifications, not straight to clients", () => {
  const taken: unknown[] = [];
  const { relay, agent, connect } = setup({ onNotify: (data: unknown) => taken.push(data) });
  const { socket } = connect();
  const before = socket.json.length;
  const data = { kind: "agent_done", title: "Done", body: "", session_id: "s1", tab_id: "t1" };
  relay.handleAgentMessage(agent, JSON.stringify({ t: "evt", event: "notify", data }));
  assert.deepEqual(taken, [data]);
  assert.equal(socket.json.length, before);

  relay.sendEvent("notify", data);
  assert.deepEqual(socket.last(), { t: "evt", event: "notify", data });
});
