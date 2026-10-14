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

/** What a path can be made of when nothing quotes it: no spaces, brackets, quotes or pipes. */
const UNQUOTED = /[^\s"'`()<>[\]{}|;,]+/gu;
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
