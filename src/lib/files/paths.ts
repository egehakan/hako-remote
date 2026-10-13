// Paths on the Mac, in the one form docs/protocol.md accepts: absolute, normalised, no trailing slash.

import { isValidPath } from "../../../shared/files.ts";

export function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** The directory a path sits in, or null for the root directory, which sits in nothing. */
export function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut === 0 ? "/" : path.slice(0, cut);
}

export function baseName(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

/** True when `path` is `directory` itself or anything below it. */
export function isWithin(directory: string, path: string): boolean {
  if (directory === "/") return true;
  return path === directory || path.startsWith(`${directory}/`);
}

/** The root a path is shown under: the deepest one that holds it. */
export function rootFor<R extends { path: string }>(path: string, roots: readonly R[]): R | null {
  let best: R | null = null;
  for (const root of roots) {
    if (isWithin(root.path, path) && (best === null || root.path.length > best.path.length)) {
      best = root;
    }
  }
  return best;
}

export type Crumb = { name: string; path: string };

/** The way from a root down to a path, the root first. Without a root it starts at `/`. */
export function crumbsFor(path: string, root: { path: string; name: string } | null): Crumb[] {
  const start = root && isWithin(root.path, path) ? root : { path: "/", name: "/" };
  const crumbs: Crumb[] = [{ name: start.name, path: start.path }];
  const rest = path.slice(start.path === "/" ? 1 : start.path.length + 1);
  let current = start.path;
  for (const segment of rest === "" ? [] : rest.split("/")) {
    current = joinPath(current, segment);
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** A path as it appears in the address: each segment escaped, the slashes kept readable. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The reverse of `encodePath`. Null for anything that is not a valid path once decoded. */
export function decodePath(encoded: string): string | null {
  try {
    const segments = encoded.split("/").map(decodeURIComponent);
    // An escaped slash would smuggle a separator into a single name.
    if (segments.some((segment) => segment.includes("/"))) return null;
    const path = segments.join("/");
    return isValidPath(path) ? path : null;
  } catch {
    return null;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where a relative link in a document leads: `../README.md` seen from `/a/docs` is `/a/README.md`.
 * Null for a link that is not a relative file path (a URL, an anchor, a path from the site root) or
 * that climbs above the root directory.
 */
export function resolveRelative(directory: string, href: string): string | null {
  const clean = href.split(/[?#]/, 1)[0];
  if (clean === "" || clean.startsWith("/") || SCHEME.test(clean)) return null;
  const segments = directory === "/" ? [] : directory.slice(1).split("/");
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  const path = `/${segments.join("/")}`;
  return isValidPath(path) ? path : null;
}
