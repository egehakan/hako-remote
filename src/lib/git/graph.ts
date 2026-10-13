// Where each commit of a history sits in the graph beside it: which lane its dot is in, and the
// lines that run through its row. Worked out from the commits' parents alone, a page at a time.

import type { GitCommit } from "../../../shared/protocol.ts";

/** Whose line a lane is: the current branch's, its upstream's, or one that was merged in. */
export type LaneKind = "head" | "upstream" | "other";

/** A lane on its way down to the commit it leads to. */
type Lane = {
  /** The commit this lane ends at, further down the list. */
  id: string;
  kind: LaneKind;
  /** False for the current branch's lane while it is only kept free, above its first commit. */
  drawn: boolean;
};

/** What the next page of commits has to know about the rows above it. */
export type GraphState = { lanes: (Lane | null)[] };

/** A line across half a row: from lane `from` at the row's edge or middle to lane `to`. */
export type Segment = { from: number; to: number; kind: LaneKind };

export type GraphRow = {
  id: string;
  /** The lane the commit's dot is in. */
  column: number;
  kind: LaneKind;
  /** How many lanes the row uses, which is how much room its drawing needs. */
  width: number;
  /** From the row's top edge to its middle. */
  top: Segment[];
  /** From the row's middle to its bottom edge. */
  bottom: Segment[];
};

export type GraphTips = {
  /** The commit HEAD is at. Its line keeps the first lane, wherever in the list it starts. */
  head: string | null;
  /** The tip of the upstream of the current branch. */
  upstream: string | null;
};

const RANK: Record<LaneKind, number> = { head: 0, upstream: 1, other: 2 };

function stronger(a: LaneKind, b: LaneKind): LaneKind {
  return RANK[a] <= RANK[b] ? a : b;
}

export function startGraph(tips: GraphTips): GraphState {
  return {
    lanes: tips.head === null ? [] : [{ id: tips.head, kind: "head", drawn: false }],
  };
}

/**
 * Lays out `commits`, which must list every child before its parents, below the rows that `state`
 * came from. Returns their rows and the state for the commits that follow.
 */
export function layoutGraph(
  commits: readonly Pick<GitCommit, "id" | "parents">[],
  tips: GraphTips,
  state: GraphState = startGraph(tips),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = state.lanes.slice();
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const top: Segment[] = [];
    const bottom: Segment[] = [];
    const arriving: number[] = [];
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index]?.id === commit.id) arriving.push(index);
    }

    let column: number;
    let kind: LaneKind =
      commit.id === tips.head ? "head" : commit.id === tips.upstream ? "upstream" : "other";
    if (arriving.length === 0) {
      const free = lanes.indexOf(null);
      column = free === -1 ? lanes.length : free;
    } else {
      column = arriving[0];
      for (const index of arriving) kind = stronger(kind, lanes[index]!.kind);
    }

    for (let index = 0; index < lanes.length; index++) {
      const lane = lanes[index];
      if (lane === null || !lane.drawn) continue;
      if (lane.id === commit.id) {
        top.push({ from: index, to: column, kind: lane.kind });
      } else {
        top.push({ from: index, to: index, kind: lane.kind });
        bottom.push({ from: index, to: index, kind: lane.kind });
      }
    }

    for (const index of arriving) lanes[index] = null;
    if (column >= lanes.length) lanes.length = column + 1;
    lanes[column] = null;

    commit.parents.forEach((parent, position) => {
      const waiting = lanes.findIndex((lane) => lane?.id === parent);
      if (position === 0) {
        // Another lane may be on its way to the same parent; the two meet in its row.
        lanes[column] = { id: parent, kind, drawn: true };
        bottom.push({ from: column, to: column, kind });
        return;
      }
      if (waiting !== -1) {
        const lane = lanes[waiting]!;
        lanes[waiting] = { ...lane, drawn: true };
        bottom.push({ from: column, to: waiting, kind: lane.kind });
        return;
      }
      // A merged-in line opens to the right of the commit, so that it crosses nothing on its way.
      let free = -1;
      for (let index = column + 1; index < lanes.length && free === -1; index++) {
        if (lanes[index] === null || lanes[index] === undefined) free = index;
      }
      const target = free === -1 ? lanes.length : free;
      const merged: LaneKind = parent === tips.upstream ? "upstream" : "other";
      lanes[target] = { id: parent, kind: merged, drawn: true };
      bottom.push({ from: column, to: target, kind: merged });
    });

    for (let index = 0; index < lanes.length; index++) lanes[index] ??= null;
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let width = column + 1;
    for (const segment of top) width = Math.max(width, segment.from + 1, segment.to + 1);
    for (const segment of bottom) width = Math.max(width, segment.from + 1, segment.to + 1);
    rows.push({ id: commit.id, column, kind, width, top, bottom });
  }

  return { rows, state: { lanes } };
}
