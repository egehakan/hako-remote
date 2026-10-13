// The rules of the transfer methods in docs/protocol.md that both ends have to agree on.

import { NAME_MAX_BYTES, nameBytes, nameProblem } from "./files.ts";

/** The largest file that travels in either direction. */
export const TRANSFER_MAX_BYTES = 50 * 1024 * 1024;
/** The most bytes one piece carries, before base64. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;
/** How long the Mac keeps an upload that nothing has been asked of. */
export const UPLOAD_IDLE_MS = 15 * 60_000;
/** How long the Mac goes on answering `fs.upload_end` for an upload that is already in place. */
export const UPLOAD_RESULT_KEPT_MS = 10 * 60_000;
/** How long a file stays in the uploads area. */
export const UPLOADS_AREA_KEPT_MS = 7 * 24 * 60 * 60_000;
/** What the client asks the relay to wait for a request that carries a piece. */
export const TRANSFER_REQUEST_TIMEOUT_MS = 60_000;

const CLEAN_STEM_MAX = 64;

/** True for one segment of a path that a file can be created under. */
export function isValidFileName(name: unknown): name is string {
  return typeof name === "string" && nameProblem(name) === null;
}

/** How many bytes the piece that starts at `offset` holds. */
export function pieceLength(offset: number, size: number, chunk: number): number {
  return Math.max(0, Math.min(chunk, size - offset));
}

/** How many pieces a file of `size` bytes travels in. An empty file needs none. */
export function pieceCount(size: number, chunk: number): number {
  return Math.ceil(size / chunk);
}

/**
 * A name cut at its last dot. The extension keeps its dot, and is empty when the name has no dot
 * or starts with its only one, as `.env` does.
 */
export function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function shortenTo(stem: string, bytes: number): string {
  let kept = Array.from(stem);
  while (kept.length > 1 && nameBytes(kept.join("")) > bytes) kept = kept.slice(0, -1);
  return kept.join("");
}

/** The name "keep both" tries as its `n`th: `notes (2).txt` for the second `notes.txt`. */
export function keepBothName(name: string, n: number): string {
  const { stem, extension } = splitName(name);
  const suffix = ` (${n})${extension}`;
  return shortenTo(stem, NAME_MAX_BYTES - nameBytes(suffix)) + suffix;
}

/**
 * The name a file gets in the uploads area: ASCII letters, digits, `.`, `_` and `-` only, so that
 * its path can be typed into a shell as it is.
 */
export function cleanUploadName(name: string): string {
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 ? name.slice(dot + 1) : "";
  const extension = /^[A-Za-z0-9]{1,8}$/.test(tail) ? `.${tail.toLowerCase()}` : "";
  const stem = (extension === "" ? name : name.slice(0, dot))
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, CLEAN_STEM_MAX)
    .replace(/[-.]+$/, "");
  return (stem === "" ? "file" : stem) + extension;
}

/** The `n`th name tried in the uploads area when the clean name is taken: `photo-2.jpg`. */
export function numberedUploadName(clean: string, n: number): string {
  const { stem, extension } = splitName(clean);
  return `${stem}-${n}${extension}`;
}

const PASTE_SAFE = /[^A-Za-z0-9._/+@%:,=~-]/g;

/**
 * A path as a terminal types it when a file is dragged in: every character a shell would read as
 * something else gets a backslash. Programs that take a dropped file undo exactly this.
 */
export function escapePathForPaste(path: string): string {
  return path.replace(PASTE_SAFE, (character) => `\\${character}`);
}
