// The text "Copy path" and "Copy relative path" put on the clipboard.

import type { FsRoot } from "../../../shared/protocol.ts";
import { isWithin } from "./paths.ts";

/**
 * A path relative to the root it belongs to, as an editor gives it relative to its workspace
 * folder: the deepest folder or terminal root that holds it, else the home root, with `.` for the
 * root itself. Outside every root it is `~/…` under `home`, and absolute anywhere else.
 */
export function relativePathFor(
  path: string,
  roots: readonly FsRoot[],
  home: string | null,
): string {
  let best: FsRoot | null = null;
  for (const root of roots) {
    if (!isWithin(root.path, path)) continue;
    const better =
      best === null ||
      (best.source === "home" && root.source !== "home") ||
      ((best.source === "home") === (root.source === "home") &&
        root.path.length > best.path.length);
    if (better) best = root;
  }
  if (best !== null) {
    if (path === best.path) return ".";
    return path.slice(best.path === "/" ? 1 : best.path.length + 1);
  }
  if (home !== null && home !== "/" && isWithin(home, path)) {
    return path === home ? "~" : `~${path.slice(home.length)}`;
  }
  return path;
}

/** `text` cut to at most `max` characters by leaving out its middle, which an ellipsis marks. */
export function shortenMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const keep = Math.max(max - 1, 2);
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}
