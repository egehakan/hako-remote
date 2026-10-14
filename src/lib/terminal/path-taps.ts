// What a tap on a path in a terminal opens. The text only says what could be a path; the Mac says
// what is there, a few `fs.stat` requests at most per tap, remembered for a while.

import type { FsRootsResult, FsStatResult } from "@shared/protocol";
import { relay, RpcFailure } from "@/lib/connection";
import { homeDirectory, setHomeDirectory } from "@/lib/paths";
import { navigate, routes } from "@/lib/route";
import { fileUrlPath, resolvePath, WRAP_ROWS, wrappedPathsAt } from "./links";
import type { BufferCell, LogicalLine, TerminalSurface } from "./surface";

export type PathKind = "dir" | "file";

/** A path that a tap may mean, with the cells it is drawn in. */
export type PathTarget = {
  path: string;
  line: number | null;
  column: number | null;
  cells: BufferCell[];
};

/** At most this many paths are asked about for one tap. */
const MAX_CHECKS = 6;
const FOUND_FOR_MS = 60_000;
const MISSING_FOR_MS = 15_000;

const known = new Map<string, { kind: PathKind | null; at: number }>();
const asking = new Map<string, Promise<PathKind | null>>();
/** False once the Mac has said it cannot stat; taps then behave as they did before paths. */
let statSupported = true;
let homeAsked: Promise<void> | null = null;
let statProbed = false;
/** True once a terminal has been opened, after which every return of the Mac is prepared for. */
let wanted = false;

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

// Another Hako may be on the other end after the Mac has been away.
let wasUp = isUp();
relay.subscribe(() => {
  const up = isUp();
  if (up === wasUp) return;
  wasUp = up;
  if (up) {
    if (wanted) prepareForPaths();
    return;
  }
  known.clear();
  statSupported = true;
  statProbed = false;
  homeAsked = null;
});

/**
 * Gets ready for taps on paths: learns the Mac's home directory, and whether it can say what is at
 * a path (an app from before round 1 cannot, and a first tap would otherwise be lost finding out).
 * Done again each time the Mac comes back.
 */
export function prepareForPaths(): void {
  wanted = true;
  if (!isUp()) return;
  void learnHome();
  if (statProbed) return;
  statProbed = true;
  relay.request("fs.stat", { path: "?" }).catch((error) => {
    if (!(error instanceof RpcFailure)) return;
    if (error.code === "not_supported") statSupported = false;
    else if (error.code !== "bad_request") statProbed = false;
  });
}

/** Asks the Mac for its home directory once per connection: another Mac may be on the other end. */
function learnHome(): Promise<void> {
  homeAsked ??= relay
    .request<FsRootsResult>("fs.roots")
    .then((roots) => setHomeDirectory(roots.home ?? null))
    .catch(() => {
      homeAsked = null;
    });
  return homeAsked;
}

/** What is known about a path: its kind, null for nothing there, undefined when not asked yet. */
function remembered(path: string): PathKind | null | undefined {
  const entry = known.get(path);
  if (!entry) return undefined;
  const age = Date.now() - entry.at;
  if (age > (entry.kind === null ? MISSING_FOR_MS : FOUND_FOR_MS)) {
    known.delete(path);
    return undefined;
  }
  return entry.kind;
}

function kindOf(result: FsStatResult): PathKind | null {
  if (result.kind === "dir") return "dir";
  // A link opens as a file; the file view moves on to the directory when it points at one.
  if (result.kind === "file" || result.kind === "symlink") return "file";
  return null;
}

function check(path: string): Promise<PathKind | null> {
  const running = asking.get(path);
  if (running) return running;
  const done = relay
    .request<FsStatResult>("fs.stat", { path })
    .then(
      (result) => {
        const kind = kindOf(result);
        known.set(path, { kind, at: Date.now() });
        return kind;
      },
      (error) => {
        if (error instanceof RpcFailure) {
          if (error.code === "not_supported") statSupported = false;
          if (error.code === "not_found" || error.code === "not_a_directory") {
            known.set(path, { kind: null, at: Date.now() });
          }
        }
        return null;
      },
    )
    .finally(() => asking.delete(path));
  asking.set(path, done);
  return done;
}

/**
 * The paths a tap on `cell` may mean, the likeliest first: an OSC 8 link to a file, then what the
 * text there reads as, the longest reading first, joined across rows where a program broke a long
 * path. With `skipCursorLine` the line the cursor is on, where a command is being typed, is left to
 * the keyboard.
 */
export function targetsAt(
  surface: TerminalSurface,
  cell: BufferCell,
  cwd: string | null,
  skipCursorLine: boolean,
): PathTarget[] {
  if (!statSupported) return [];
  const targets: PathTarget[] = [];
  const uri = surface.linkAt(cell);
  const linked = uri === null ? null : fileUrlPath(uri);
  if (linked !== null) targets.push({ path: linked, line: null, column: null, cells: [cell] });

  const typing = (line: LogicalLine) =>
    skipCursorLine && line.cells.some((drawn) => drawn.line === surface.cursorLine);
  const tapped = surface.logicalLine(cell.line);
  if (typing(tapped)) return targets;
  const index = tapped.cells.findIndex(
    (drawn) => drawn.line === cell.line && drawn.col === cell.col,
  );
  if (index === -1) return targets;

  const lines = [tapped];
  // A link already says where all of it is, however it was broken.
  if (linked === null) {
    while (lines.length <= WRAP_ROWS && lines[0].first > 0) {
      const previous = surface.logicalLine(lines[0].first - 1);
      if (typing(previous)) break;
      lines.unshift(previous);
    }
    const after = lines.length + WRAP_ROWS;
    while (lines.length < after && lines[lines.length - 1].last + 1 < surface.lineCount) {
      const next = surface.logicalLine(lines[lines.length - 1].last + 1);
      if (typing(next)) break;
      lines.push(next);
    }
  }
  const at = lines.indexOf(tapped);
  const home = homeDirectory();
  const rows = lines.map((line) => line.text);
  for (const found of wrappedPathsAt(rows, at, index)) {
    const path = resolvePath(found.path, cwd, home);
    if (path === null || targets.some((target) => target.path === path)) continue;
    targets.push({
      path,
      line: found.line,
      column: found.column,
      cells: found.spans.flatMap((span) => lines[span.row].cells.slice(span.start, span.end)),
    });
  }
  return targets.slice(0, MAX_CHECKS);
}

/** The address of an OSC 8 link that is a web page, which opens in a new tab. */
export function webLink(uri: string | null): string | null {
  return uri !== null && /^https?:\/\//i.test(uri) ? uri : null;
}

export function openPath(target: PathTarget, kind: PathKind): void {
  navigate(kind === "dir" ? routes.dir(target.path) : routes.file(target.path, target.line));
}

/** The first target that is known to be there, or "unknown" while some are still to be asked. */
export function knownTarget(
  targets: readonly PathTarget[],
): { target: PathTarget; kind: PathKind } | "unknown" | null {
  let unknown = false;
  for (const target of targets) {
    const kind = remembered(target.path);
    if (kind === undefined) unknown = true;
    else if (kind !== null && !unknown) return { target, kind };
  }
  return unknown ? "unknown" : null;
}

/** Asks the Mac about all the targets at once and gives the first in order that is there. */
export async function findTarget(
  targets: readonly PathTarget[],
): Promise<{ target: PathTarget; kind: PathKind } | null> {
  const kinds = targets.map((target) => {
    const kind = remembered(target.path);
    return kind === undefined ? check(target.path) : Promise.resolve(kind);
  });
  for (const [order, target] of targets.entries()) {
    const kind = await kinds[order];
    if (kind !== null) return { target, kind };
  }
  return null;
}
