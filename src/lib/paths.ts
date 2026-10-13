const HOME = /^\/(?:Users|home)\/[^/]+/;

let home: string | null = null;

/** Tells `tildify` where the Mac's home directory really is, once the Mac has said so. */
export function setHomeDirectory(path: string | null): void {
  home = path;
}

/** Shows a home directory as `~`, the way a shell prompt does. */
export function tildify(path: string): string {
  if (home !== null && home !== "/" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path.replace(HOME, "~");
}

/**
 * A working directory as it reads inside a folder: nothing for the folder itself (the folder
 * already says where that is), `./app` below it, and the full path anywhere else.
 */
export function relativeTo(directory: string, path: string): string | null {
  if (path === directory) return null;
  if (path.startsWith(`${directory}/`)) return `./${path.slice(directory.length + 1)}`;
  return tildify(path);
}
