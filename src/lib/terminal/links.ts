// Paths in a terminal's text, found the way a person reads them: absolute, from the home
// directory, or relative to where the terminal is, with an optional line and column after them.
// Whether something is really there is for the Mac to say; this only finds what could be a path.

export type PathCandidate = {
  /** Where the path's text starts and ends in the line, the end not included. */
  start: number;
  end: number;
  /** The path as written: `/a/b`, `~/a`, `./a`, `a/b` or `name.ext`. */
  path: string;
  line: number | null;
  column: number | null;
};

/**
 * What a path can be made of when nothing quotes it: no spaces, brackets, quotes, pipes or the
 * lines of a box drawn around text.
 */
const UNQUOTED = /[^\s"'`()<>[\]{}|;,\u2500-\u257f]+/gu;
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g;
/** A line and an optional column after a path, as compilers and editors write them. */
const POSITION = /:(\d+)(?::(\d+))?$/;
/** `file.ts(12,5)`, as the TypeScript compiler writes a position. */
const PAREN_POSITION = /^\((\d+)(?:,(\d+))?\)/;
const TRAILING = /[.,:;!?]+$/;
const LEADING = /^[:=]+/;
/** A name with an extension that starts with a letter: `README.md`, `index.html`, not `1.2.3`. */
const NAMED_FILE = /^[\p{L}\p{N}_@+-][\p{L}\p{N}._@+-]*\.[\p{L}][\p{L}\p{N}_-]{0,11}$/u;

/** True for text that could name a file or a directory, before anybody has looked. */
export function looksLikePath(text: string): boolean {
  if (text.length < 2 || text.includes("://") || text.includes("\0")) return false;
  if (text === "~" || text === ".." || /^\.+$/.test(text)) return false;
  if (text.startsWith("/")) return text.length > 1 && !text.startsWith("//");
  if (text.startsWith("~/")) return text.length > 2;
  if (text.startsWith("./") || text.startsWith("../")) return true;
  if (text.includes("/")) return /^[\p{L}\p{N}._@~+-]/u.test(text);
  return NAMED_FILE.test(text);
}

/** Splits a trailing `:line` or `:line:column` off a path. */
function withPosition(text: string): { path: string; line: number | null; column: number | null } {
  const match = POSITION.exec(text);
  if (!match) return { path: text, line: null, column: null };
  return {
    path: text.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] === undefined ? null : Number(match[2]),
  };
}

/** `token` found at `start`, followed in the line by `rest`, as a path if it can be one. */
function candidate(token: string, start: number, rest: string): PathCandidate | null {
  const lead = LEADING.exec(token)?.[0].length ?? 0;
  const body = token.slice(lead);
  const trimmed = body.replace(TRAILING, "");
  const parsed = withPosition(trimmed);
  let { line, column } = parsed;
  let end = start + lead + trimmed.length;
  if (line === null && trimmed === body) {
    const paren = PAREN_POSITION.exec(rest);
    if (paren) {
      line = Number(paren[1]);
      column = paren[2] === undefined ? null : Number(paren[2]);
      end += paren[0].length;
    }
  }
  if (!looksLikePath(parsed.path) || (line !== null && line < 1)) return null;
  return { start: start + lead, end, path: parsed.path, line, column };
}

/** Every stretch of a line that could be a path, quoted ones first. */
export function findPaths(text: string): PathCandidate[] {
  const found: PathCandidate[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const inner = match[1] ?? match[2] ?? match[3];
    const start = (match.index ?? 0) + 1;
    const parsed = candidate(inner, start, "");
    // A quoted stretch is one path only when all of it is one, spaces and all.
    if (parsed && parsed.end === start + inner.replace(TRAILING, "").length) found.push(parsed);
  }
  for (const match of text.matchAll(UNQUOTED)) {
    const start = match.index ?? 0;
    const parsed = candidate(match[0], start, text.slice(start + match[0].length));
    if (
      parsed &&
      !found.some((other) => other.start === parsed.start && other.end === parsed.end)
    ) {
      found.push(parsed);
    }
  }
  return found;
}

/** The paths that cover the character at `index`, the one to try first first. */
export function pathsAt(text: string, index: number): PathCandidate[] {
  return findPaths(text).filter((found) => index >= found.start && index < found.end);
}

/** A stretch of one of the rows a path is read from, the end not included. */
export type Span = { row: number; start: number; end: number };

/** A reading of a tap, perhaps across rows that a program broke a long path onto. */
export type WrappedCandidate = {
  path: string;
  line: number | null;
  column: number | null;
  /** Where its text is, in reading order. */
  spans: Span[];
};

/** How many rows before and after the tapped one a path may have been broken onto. */
export const WRAP_ROWS = 4;
/** At most this many readings across rows are offered for one tap. */
const MAX_JOINED = 5;
/** What may stand between text and the edge of its row: spaces and the lines of a box. */
const MARGIN = /^[\s\u2500-\u257f]*$/u;
const LEADING_MARGIN = /^[\s\u2500-\u257f]*/u;

function tokens(text: string): { start: number; end: number }[] {
  return [...text.matchAll(UNQUOTED)].map((match) => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  });
}

/** The first word of a row when nothing but indentation or a box's edge comes before it. */
function firstToken(text: string): { start: number; end: number } | null {
  const lead = LEADING_MARGIN.exec(text)?.[0].length ?? 0;
  return tokens(text).find((token) => token.start === lead) ?? null;
}

/** The last word of a row when nothing but spaces or a box's edge comes after it. */
function lastToken(text: string): { start: number; end: number } | null {
  const last = tokens(text).at(-1);
  return last && MARGIN.test(text.slice(last.end)) ? last : null;
}

/**
 * The paths a tap at `index` of `rows[at]` may mean, the longest first. Each row is a line as the
 * terminal wrapped it; a program that breaks long lines itself (Claude Code, git, a Markdown
 * renderer) leaves a path that reaches the end of a row going on at the start of the next, after
 * its indentation or the side of a box, so those words are joined too, up to `WRAP_ROWS` each way.
 * Whether a joined reading is a path is for the Mac to say.
 */
export function wrappedPathsAt(
  rows: readonly string[],
  at: number,
  index: number,
): WrappedCandidate[] {
  const text = rows[at] ?? "";
  const plain = pathsAt(text, index).map(({ path, line, column, start, end }) => ({
    path,
    line,
    column,
    spans: [{ row: at, start, end }],
  }));
  const tapped = tokens(text).find((token) => index >= token.start && index < token.end);
  if (!tapped) return plain;

  const pieces: Span[] = [{ row: at, ...tapped }];
  for (let row = at; row + 1 < rows.length && row - at < WRAP_ROWS; row += 1) {
    const last = pieces[pieces.length - 1];
    if (!MARGIN.test(rows[row].slice(last.end))) break;
    const next = firstToken(rows[row + 1]);
    if (!next) break;
    pieces.push({ row: row + 1, ...next });
  }
  let before = 0;
  for (let row = at; row > 0 && before < WRAP_ROWS; row -= 1) {
    if (!MARGIN.test(rows[row].slice(0, pieces[0].start))) break;
    const previous = lastToken(rows[row - 1]);
    if (!previous) break;
    pieces.unshift({ row: row - 1, ...previous });
    before += 1;
  }

  const joined: WrappedCandidate[] = [];
  for (let from = 0; from <= before; from += 1) {
    for (let to = before; to < pieces.length; to += 1) {
      if (from === to) continue;
      const chosen = pieces.slice(from, to + 1);
      const offsets: number[] = [];
      let words = "";
      for (const piece of chosen) {
        offsets.push(words.length);
        words += rows[piece.row].slice(piece.start, piece.end);
      }
      for (const found of findPaths(words)) {
        // Prose broken between two words would otherwise join them into a name.
        if (!found.path.includes("/")) continue;
        const spans = chosen.flatMap((piece, order) => {
          const start = Math.max(found.start, offsets[order]);
          const end = Math.min(found.end, offsets[order] + piece.end - piece.start);
          if (start >= end) return [];
          const shift = piece.start - offsets[order];
          return [{ row: piece.row, start: start + shift, end: end + shift }];
        });
        // Every row chosen takes part, the tapped one included; fewer is another reading.
        if (spans.length !== chosen.length) continue;
        joined.push({ path: found.path, line: found.line, column: found.column, spans });
      }
    }
  }
  const size = (found: WrappedCandidate) =>
    found.spans.reduce((sum, span) => sum + span.end - span.start, 0);
  const longest = joined
    .sort((a, b) => size(b) - size(a))
    .filter(
      (found, order, all) =>
        all.findIndex((other) => other.path === found.path && other.line === found.line) === order,
    )
    .slice(0, MAX_JOINED);
  return [...longest, ...plain];
}

/** Removes `.` and `..` segments and doubled slashes. Null when `..` climbs above `/`. */
export function normalizePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

/**
 * The absolute path a written path names, for a terminal in `cwd` on a Mac whose home is `home`.
 * Null when it cannot be told: a relative path without a working directory, `~` without a home.
 */
export function resolvePath(path: string, cwd: string | null, home: string | null): string | null {
  if (path.startsWith("/")) return normalizePath(path);
  if (path === "~" || path.startsWith("~/")) {
    return home === null ? null : normalizePath(`${home}/${path.slice(1)}`);
  }
  if (path.startsWith("~")) return null;
  return cwd === null ? null : normalizePath(`${cwd}/${path}`);
}

/**
 * The path of an OSC 8 hyperlink's `file://` address, whatever host it names (the terminal is on
 * the Mac, so every host is the Mac). Null for any other address.
 */
export function fileUrlPath(uri: string): string | null {
  const match = /^file:\/\/([^/]*)(\/[^?#]*)/i.exec(uri);
  if (!match) return null;
  try {
    const path = decodeURIComponent(match[2]);
    return path.includes("\0") ? null : normalizePath(path);
  } catch {
    return null;
  }
}

/** The `uri` of an OSC 8 sequence's data (`params;uri`), which is empty where a link ends. */
export function osc8Uri(data: string): string {
  const cut = data.indexOf(";");
  return cut === -1 ? "" : data.slice(cut + 1);
}

export type CellBox = { left: number; top: number; width: number; height: number };

/**
 * The cell under a point, counted from 0, for a grid of `cols` x `rows` drawn in `box` on screen.
 * The box is measured on screen, so a scaled or zoomed terminal maps as it is drawn. Null outside.
 */
export function cellAt(
  x: number,
  y: number,
  box: CellBox,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  if (box.width <= 0 || box.height <= 0 || cols < 1 || rows < 1) return null;
  const col = Math.floor(((x - box.left) / box.width) * cols);
  const row = Math.floor(((y - box.top) / box.height) * rows);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  return { col, row };
}
