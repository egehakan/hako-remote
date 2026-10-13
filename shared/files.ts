// The rules of the file methods in docs/protocol.md that both ends have to agree on.

import type { FsEntry } from "./protocol.ts";

export const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const LIST_LIMIT = 20_000;

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The media type `fs.read` answers with for an image file, or null for every other file. */
export function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MIMES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True for the media types a client may put into an `<img>`. */
export function isImageMime(mime: string): boolean {
  return Object.values(IMAGE_MIMES).includes(mime);
}

/** True for a path in the one form the protocol accepts: absolute, and already normalised. */
export function isValidPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (path === "/") return true;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isDirectory(entry: Pick<FsEntry, "kind" | "target">): boolean {
  return entry.kind === "dir" || (entry.kind === "symlink" && entry.target === "dir");
}

function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const difference = left[index].codePointAt(0)! - right[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** The order `fs.list` answers in: directories first, then by lower-cased name, then by name. */
export function compareEntries(a: FsEntry, b: FsEntry): number {
  const directories = Number(isDirectory(b)) - Number(isDirectory(a));
  if (directories !== 0) return directories;
  return byCodePoint(a.name.toLowerCase(), b.name.toLowerCase()) || byCodePoint(a.name, b.name);
}
