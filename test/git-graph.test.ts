import assert from "node:assert/strict";
import { test } from "node:test";
import { type GraphRow, layoutGraph, startGraph } from "../src/lib/git/graph.ts";

type Commit = { id: string; parents: string[] };

const commit = (id: string, ...parents: string[]): Commit => ({ id, parents });

/** A row as one line: its lane, its kind, and the lines of its two halves as `from>to`. */
function sketch(row: GraphRow): string {
  const lines = (segments: GraphRow["top"]) =>
    segments.map((segment) => `${segment.from}>${segment.to}${segment.kind[0]}`).join(" ");
  return `${row.id}@${row.column}${row.kind[0]} | ${lines(row.top)} | ${lines(row.bottom)}`;
}

function rowsOf(commits: Commit[], head: string | null, upstream: string | null = null): string[] {
  return layoutGraph(commits, { head, upstream }).rows.map(sketch);
}

test("a linear history is one line in the first lane", () => {
  const rows = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")], {
    head: "c",
    upstream: null,
  }).rows;
  assert.deepEqual(rows.map(sketch), ["c@0h |  | 0>0h", "b@0h | 0>0h | 0>0h", "a@0h | 0>0h | "]);
  assert.deepEqual(
    rows.map((row) => row.width),
    [1, 1, 1],
  );
});

test("a merge opens a lane to its right, which closes where the two lines meet", () => {
  const rows = rowsOf(
    [commit("m", "b", "s"), commit("s", "a"), commit("b", "a"), commit("a")],
    "m",
  );
  assert.deepEqual(rows, [
    "m@0h |  | 0>0h 0>1o",
    "s@1o | 0>0h 1>1o | 0>0h 1>1o",
    "b@0h | 0>0h 1>1o | 1>1o 0>0h",
    "a@0h | 0>0h 1>0o | ",
  ]);
});

test("a merged-in line that is listed after the first parent still keeps to its lane", () => {
  const rows = layoutGraph(
    [commit("m", "b", "s"), commit("b", "a"), commit("s", "a"), commit("a")],
    { head: "m", upstream: null },
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.id, row.column, row.width]),
    [
      ["m", 0, 2],
      ["b", 0, 2],
      ["s", 1, 2],
      ["a", 0, 2],
    ],
  );
});

test("the current branch keeps the first lane while its upstream runs beside it", () => {
  // Two commits to pull, listed first, and two to push, on a shared base.
  const rows = rowsOf(
    [
      commit("u2", "u1"),
      commit("u1", "base"),
      commit("h2", "h1"),
      commit("h1", "base"),
      commit("base", "root"),
      commit("root"),
    ],
    "h2",
    "u2",
  );
  assert.deepEqual(rows, [
    "u2@1u |  | 1>1u",
    "u1@1u | 1>1u | 1>1u",
    "h2@0h | 1>1u | 1>1u 0>0h",
    "h1@0h | 0>0h 1>1u | 1>1u 0>0h",
    "base@0h | 0>0h 1>0u | 0>0h",
    "root@0h | 0>0h | ",
  ]);
});

test("an upstream that is only ahead joins the current branch at its commit", () => {
  const rows = rowsOf([commit("u1", "h"), commit("h", "a"), commit("a")], "h", "u1");
  assert.deepEqual(rows, ["u1@1u |  | 1>1u", "h@0h | 1>0u | 0>0h", "a@0h | 0>0h | "]);
});

test("an upstream that is behind is a commit on the current branch's line", () => {
  const rows = rowsOf([commit("h2", "h1"), commit("h1", "u"), commit("u")], "h2", "u");
  assert.deepEqual(rows, ["h2@0h |  | 0>0h", "h1@0h | 0>0h | 0>0h", "u@0h | 0>0h | "]);
});

test("merging the upstream draws its line in the upstream's colour", () => {
  const rows = rowsOf(
    [commit("m", "h", "u"), commit("u", "a"), commit("h", "a"), commit("a")],
    "m",
    "u",
  );
  assert.equal(rows[0], "m@0h |  | 0>0h 0>1u");
  assert.equal(rows[1], "u@1u | 0>0h 1>1u | 0>0h 1>1u");
});

test("a second merge reuses the lane the first one gave back", () => {
  const rows = layoutGraph(
    [
      commit("m2", "m1", "t"),
      commit("t", "m1"),
      commit("m1", "a", "s"),
      commit("s", "a"),
      commit("a"),
    ],
    { head: "m2", upstream: null },
  ).rows;
  assert.deepEqual(
    rows.map((row) => row.column),
    [0, 1, 0, 1, 0],
  );
  assert.ok(rows.every((row) => row.width <= 2));
});

test("pages laid out one after another give the rows of the whole history", () => {
  const history = [
    commit("u1", "m2"),
    commit("h1", "m2"),
    commit("m2", "c", "t2"),
    commit("t2", "t1"),
    commit("c", "m1"),
    commit("t1", "m1"),
    commit("m1", "b", "s"),
    commit("b", "a"),
    commit("s", "a"),
    commit("a", "root"),
    commit("root"),
  ];
  const tips = { head: "h1", upstream: "u1" };
  const whole = layoutGraph(history, tips).rows;
  for (let size = 1; size < history.length; size++) {
    const rows: GraphRow[] = [];
    let state = startGraph(tips);
    for (let start = 0; start < history.length; start += size) {
      const page = layoutGraph(history.slice(start, start + size), tips, state);
      rows.push(...page.rows);
      state = page.state;
    }
    assert.deepEqual(rows, whole, `in pages of ${size}`);
  }
});

test("a line that the page ends on is still open for the next page", () => {
  const tips = { head: "m", upstream: null };
  const first = layoutGraph([commit("m", "b", "s"), commit("b", "a")], tips);
  assert.equal(first.state.lanes.filter((lane) => lane !== null).length, 2);
  const [next] = layoutGraph([commit("s", "a")], tips, first.state).rows;
  assert.equal(sketch(next), "s@1o | 0>0h 1>1o | 0>0h 1>1o");
});

test("a history with no commits has no rows and no lanes", () => {
  const { rows, state } = layoutGraph([], { head: null, upstream: null });
  assert.deepEqual(rows, []);
  assert.deepEqual(state.lanes, []);
});
