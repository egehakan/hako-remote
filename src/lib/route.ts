import { useSyncExternalStore } from "react";
import { isValidRepoPath } from "../../shared/git.ts";
import { decodePath, encodePath } from "./files/paths";

export type Route =
  | { name: "workspace" }
  | { name: "tab"; tabId: string }
  /** One live terminal, by session id, so a link or a notification can open it directly. */
  | { name: "terminal"; sessionId: string }
  /** The places file browsing starts from. */
  | { name: "files" }
  | { name: "dir"; path: string }
  | { name: "file"; path: string }
  /** Every repository on the Mac. */
  | { name: "git" }
  /** One repository's changed files, by the path of its working tree. */
  | { name: "repo"; repo: string }
  /** One changed file's diff. `file` is relative to the repository. */
  | { name: "diff"; repo: string; file: string }
  | { name: "account" };

export type Area = "terminals" | "files" | "git" | "account";

export function areaOf(route: Route): Area {
  switch (route.name) {
    case "workspace":
    case "tab":
    case "terminal":
      return "terminals";
    case "files":
    case "dir":
    case "file":
      return "files";
    case "git":
    case "repo":
    case "diff":
      return "git";
    case "account":
      return "account";
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "account") return { name: "account" };
  if (path === "git") return { name: "git" };
  if (path.startsWith("git/r/")) return parseRepoRoute(path.slice(5));
  if (path === "files") return { name: "files" };
  if (path.startsWith("tab/")) return { name: "tab", tabId: decodeURIComponent(path.slice(4)) };
  if (path.startsWith("t/") && path.length > 2) {
    return { name: "terminal", sessionId: decodeURIComponent(path.slice(2)) };
  }
  for (const name of ["dir", "file"] as const) {
    if (!path.startsWith(`${name}/`)) continue;
    const decoded = decodePath(path.slice(name.length));
    return decoded === null ? { name: "files" } : { name, path: decoded };
  }
  return { name: "workspace" };
}

/** `<repository path>` or `<repository path>?f=<file>`, both escaped. */
function parseRepoRoute(rest: string): Route {
  const mark = rest.indexOf("?f=");
  const repo = decodePath(mark === -1 ? rest : rest.slice(0, mark));
  if (repo === null) return { name: "git" };
  if (mark === -1) return { name: "repo", repo };
  try {
    const file = decodeURIComponent(rest.slice(mark + 3));
    return isValidRepoPath(file) ? { name: "diff", repo, file } : { name: "repo", repo };
  } catch {
    return { name: "repo", repo };
  }
}

type Blocker = {
  /** True when going to `next` would throw away something the owner has not saved. */
  blocks: (next: Route) => boolean;
  /** Called with the address that was refused, to ask the owner and perhaps go there after all. */
  onBlocked: (hash: string) => void;
};

// The address the app is showing. It trails `location.hash` for the moment it takes to decide
// whether a navigation may happen, so a blocked one never reaches a screen.
let current = window.location.hash;
let blocker: Blocker | null = null;
const listeners = new Set<() => void>();

window.addEventListener("hashchange", () => {
  const next = window.location.hash;
  if (next === current) return;
  if (blocker?.blocks(parseRoute(next))) {
    window.history.replaceState(null, "", current === "" ? window.location.pathname : current);
    blocker.onBlocked(next);
    return;
  }
  current = next;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getHash = () => current;

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, getHash));
}

/** One screen at a time may hold navigation back; passing null lets it go again. */
export function setNavigationBlocker(next: Blocker | null): void {
  blocker = next;
}

export const routes = {
  workspace: "#/",
  account: "#/account",
  git: "#/git",
  repo: (repo: string) => `#/git/r${encodePath(repo)}`,
  diff: (repo: string, file: string) => `#/git/r${encodePath(repo)}?f=${encodeURIComponent(file)}`,
  files: "#/files",
  tab: (tabId: string) => `#/tab/${encodeURIComponent(tabId)}`,
  terminal: (sessionId: string) => `#/t/${encodeURIComponent(sessionId)}`,
  dir: (path: string) => `#/dir${encodePath(path)}`,
  file: (path: string) => `#/file${encodePath(path)}`,
};

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  if (window.location.hash === hash) return;
  if (options.replace) {
    window.location.replace(hash);
  } else {
    window.location.hash = hash;
  }
}
