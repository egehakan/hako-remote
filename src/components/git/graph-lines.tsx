import type { GitSide } from "@shared/protocol";
import { memo } from "react";
import type { GraphRow, LaneKind, Segment } from "@/lib/git/graph";
import { cn } from "@/lib/utils";

/** The width of one lane and the height of one row, in CSS pixels. */
export const LANE_WIDTH = 14;
export const GRAPH_ROW_HEIGHT = 52;
/** More lanes than this are cut off, so that a tangled history leaves the subject its room. */
const MAX_LANES = 6;

const STROKES: Record<LaneKind, string> = {
  head: "stroke-amber",
  upstream: "stroke-remote",
  other: "stroke-faint",
};
const FILLS: Record<LaneKind, string> = {
  head: "fill-amber",
  upstream: "fill-remote",
  other: "fill-faint",
};

const MIDDLE = GRAPH_ROW_HEIGHT / 2;
const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

/** A line down half a row: straight within its lane, an S-curve from one lane to another. */
function path(segment: Segment, half: "top" | "bottom"): string {
  const from = x(segment.from);
  const to = x(segment.to);
  const start = half === "top" ? 0 : MIDDLE;
  const end = start + MIDDLE;
  if (from === to) return `M${from} ${start}V${end}`;
  const bend = MIDDLE * 0.62;
  return `M${from} ${start}C${from} ${start + bend} ${to} ${end - bend} ${to} ${end}`;
}

export function graphWidth(row: GraphRow): number {
  return Math.min(row.width, MAX_LANES) * LANE_WIDTH;
}

type GraphLinesProps = {
  row: GraphRow;
  side: GitSide;
  merge: boolean;
  /** True for the commit HEAD is at. */
  head: boolean;
};

/**
 * One row of the graph: the lines that pass through it and the commit's dot. A commit that only one
 * side has is drawn as a ring, a merge as a ring with a dot in it, and the rest are filled.
 */
export const GraphLines = memo(function GraphLines({ row, side, merge, head }: GraphLinesProps) {
  const width = graphWidth(row);
  const colour: LaneKind = side === "local" ? "head" : side === "remote" ? "upstream" : row.kind;
  const hollow = side !== "both" || merge;
  const radius = hollow ? (head ? 4.75 : 4) : head ? 5.25 : 4.5;
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
      className="shrink-0 overflow-hidden"
      fill="none"
      strokeWidth={1.75}
      strokeLinecap="round"
    >
      {row.top.map((segment) => (
        <path
          key={`t${segment.from}:${segment.to}`}
          d={path(segment, "top")}
          className={STROKES[segment.kind]}
        />
      ))}
      {row.bottom.map((segment) => (
        <path
          key={`b${segment.from}:${segment.to}`}
          d={path(segment, "bottom")}
          className={STROKES[segment.kind]}
        />
      ))}
      <circle
        cx={x(row.column)}
        cy={MIDDLE}
        r={radius}
        strokeWidth={hollow ? 1.75 : 1.5}
        className={cn(
          hollow ? "fill-background" : FILLS[colour],
          hollow ? STROKES[colour] : "stroke-background",
        )}
      />
      {merge ? (
        <circle cx={x(row.column)} cy={MIDDLE} r={1.5} stroke="none" className={FILLS[colour]} />
      ) : null}
    </svg>
  );
});
