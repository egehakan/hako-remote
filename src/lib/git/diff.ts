// Reads the unified diff `git.diff` answers with into lines that can be drawn: numbered, marked as
// added or removed, and with the part of a changed line that really changed pointed out.

export type DiffLineKind = "context" | "add" | "del" | "note";

/** A half-open range of UTF-16 offsets into a line's text. */
export type Span = { from: number; to: number };

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** The line's number in the old file, or null for an added line and for a note. */
  oldNumber: number | null;
  /** The line's number in the new file, or null for a removed line and for a note. */
  newNumber: number | null;
  /** The part that differs from the line it replaced or was replaced by, when the two were paired. */
  changed: Span | null;
};

export type Hunk = {
  /** The `@@ -1,3 +1,7 @@` part. */
  range: string;
  /** What git printed after the range: usually the function or section the hunk is in. */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  hunks: Hunk[];
  /** Lines of every kind in all hunks, which is what decides how much there is to draw. */
  lineCount: number;
  additions: number;
  deletions: number;
  /** What the header says besides the two file names, such as a rename or a change of mode. */
  notes: string[];
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** Header lines worth telling the owner, in their own words. */
function headerNote(line: string): string | null {
  if (line.startsWith("old mode ")) return `Mode was ${line.slice(9)}`;
  if (line.startsWith("new mode ")) return `Mode is now ${line.slice(9)}`;
  if (line.startsWith("similarity index ")) return null;
  if (line.startsWith("rename from ")) return `Renamed from ${line.slice(12)}`;
  if (line.startsWith("* Unmerged path ")) return "This file is in conflict";
  return null;
}

export function parseDiff(text: string): ParsedDiff {
  const parsed: ParsedDiff = { hunks: [], lineCount: 0, additions: 0, deletions: 0, notes: [] };
  let hunk: Hunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  const lines = text.split("\n");
  // The text ends with a line break, which is not one more, empty, line.
  if (lines.at(-1) === "") lines.pop();

  for (const raw of lines) {
    const start = HUNK.exec(raw);
    if (start) {
      oldNumber = Number(start[1]);
      newNumber = Number(start[2]);
      hunk = {
        range: raw.slice(0, raw.indexOf(" @@", 3) + 3),
        section: start[3],
        oldStart: oldNumber,
        newStart: newNumber,
        lines: [],
      };
      parsed.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      const note = headerNote(raw);
      if (note !== null) parsed.notes.push(note);
      continue;
    }
    const sign = raw[0];
    const body = raw.slice(1);
    let line: DiffLine;
    if (sign === "+") {
      line = { kind: "add", text: body, oldNumber: null, newNumber: newNumber++, changed: null };
      parsed.additions++;
    } else if (sign === "-") {
      line = { kind: "del", text: body, oldNumber: oldNumber++, newNumber: null, changed: null };
      parsed.deletions++;
    } else if (sign === "\\") {
      // "\ No newline at end of file" speaks about the line before it.
      line = { kind: "note", text: body.trim(), oldNumber: null, newNumber: null, changed: null };
    } else if (sign === " " || sign === undefined) {
      // Some tools strip the single space of an empty context line.
      line = {
        kind: "context",
        text: body,
        oldNumber: oldNumber++,
        newNumber: newNumber++,
        changed: null,
      };
    } else {
      // Not part of a hunk: the header of another file, which a diff of one path never has.
      hunk = null;
      continue;
    }
    hunk.lines.push(line);
    parsed.lineCount++;
  }

  for (const each of parsed.hunks) markChangedParts(each.lines);
  return parsed;
}

/** Lines longer than this are not compared word by word. */
const MAX_COMPARED_LENGTH = 2_000;
/** A pair that shares less than this share of its text is two different lines, not one edited. */
const MIN_SHARED = 0.3;

const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokens(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * The part of each of two lines that is not shared with the other: what is left when the words
 * both start with and both end with are taken away. Null when the lines have too little in common
 * for that to say anything, or nothing at all differs.
 */
export function changedParts(before: string, after: string): { before: Span; after: Span } | null {
  if (before.length > MAX_COMPARED_LENGTH || after.length > MAX_COMPARED_LENGTH) return null;
  const left = tokens(before);
  const right = tokens(after);
  const shortest = Math.min(left.length, right.length);
  let head = 0;
  let headLength = 0;
  while (head < shortest && left[head] === right[head]) headLength += left[head++].length;
  let tail = 0;
  let tailLength = 0;
  while (
    tail < shortest - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tailLength += left[left.length - 1 - tail].length;
    tail++;
  }
  const shared = headLength + tailLength;
  const longest = Math.max(before.length, after.length);
  if (longest === 0 || shared / longest < MIN_SHARED) return null;
  if (shared === before.length && shared === after.length) return null;
  return {
    before: { from: headLength, to: before.length - tailLength },
    after: { from: headLength, to: after.length - tailLength },
  };
}

/**
 * Pairs removed lines with the added lines that follow them, first with first, and marks what
 * changed inside each pair. Only runs of equal length are paired: anything else is a rewrite, where
 * a line's partner is a guess.
 */
function markChangedParts(lines: DiffLine[]): void {
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "del") {
      index++;
      continue;
    }
    const firstRemoved = index;
    while (index < lines.length && lines[index].kind === "del") index++;
    const firstAdded = index;
    while (index < lines.length && lines[index].kind === "add") index++;
    const removed = firstAdded - firstRemoved;
    if (removed !== index - firstAdded) continue;
    for (let pair = 0; pair < removed; pair++) {
      const before = lines[firstRemoved + pair];
      const after = lines[firstAdded + pair];
      const parts = changedParts(before.text, after.text);
      if (parts === null) continue;
      before.changed = parts.before;
      after.changed = parts.after;
    }
  }
}
