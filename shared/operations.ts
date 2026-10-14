// The rules of the file operations of round 1 in docs/protocol.md that both ends have to agree on.

import { keepBothName, splitName } from "./transfers.ts";
import { NAME_MAX_BYTES, nameBytes } from "./files.ts";

/** What the client asks the relay to wait for a copy, a move, a zip or an unzip. */
export const OPERATION_TIMEOUT_MS = 300_000;
/** How long the Mac works on one of those before it stops. */
export const OPERATION_DEADLINE_MS = 240_000;
/** The most items one copy, move or trash names. */
export const MAX_SOURCES = 500;
/** The largest a zip may unpack to. */
export const EXTRACT_MAX_BYTES = 1024 * 1024 * 1024;
/** The most entries a zip may hold to be unpacked. */
export const EXTRACT_MAX_ENTRIES = 50_000;
/** How long an archive made for downloading is kept on the Mac. */
export const ARCHIVE_KEPT_MS = 60 * 60_000;

/** Directories `skip_heavy` leaves out by their name alone. */
export const HEAVY_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".gradle",
  "Pods",
  "DerivedData",
];

/** Files that mark a `target` directory as a build's output, which `skip_heavy` leaves out too. */
export const BUILD_OUTPUT_MARKERS: readonly string[] = ["CACHEDIR.TAG", ".rustc_info.json"];

/**
 * The name "keep both" tries as its `n`th, from 2: a file is numbered before its extension
 * (`notes (2).txt`), a directory at the end of its whole name (`v1.2 (2)`).
 */
export function keepBothNameFor(name: string, isDirectory: boolean, n: number): string {
  if (!isDirectory) return keepBothName(name, n);
  const suffix = ` (${n})`;
  let kept = Array.from(name);
  while (kept.length > 1 && nameBytes(kept.join("")) > NAME_MAX_BYTES - nameBytes(suffix)) {
    kept = kept.slice(0, -1);
  }
  return kept.join("") + suffix;
}

/**
 * The first name of `name`, `name (2)`, `name (3)` … that `taken` does not hold. Names are compared
 * as a Mac's disk compares them by default: without regard to letter case or Unicode
 * normalisation.
 */
export function firstFreeName(name: string, isDirectory: boolean, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, sameNameKey));
  if (!used.has(sameNameKey(name))) return name;
  for (let n = 2; ; n++) {
    const candidate = keepBothNameFor(name, isDirectory, n);
    if (!used.has(sameNameKey(candidate))) return candidate;
  }
}

/** One key for every spelling a Mac's disk takes for the same name. */
export function sameNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** The directory a zip unpacks into: its name without the extension. */
export function extractedName(zipName: string): string {
  return splitName(zipName).stem;
}
