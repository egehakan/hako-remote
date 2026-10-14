import { useSyncExternalStore } from "react";
import { isCommitId, isValidRepoPath } from "../../shared/git.ts";
import { isPreviewId } from "../../shared/previews.ts";
import { decodePath, encodePath } from "./files/paths";

export type Route =
  | { name: "workspace" }
  | { name: "tab"; tabId: string }
  /** One live terminal, by session id, so a link or a notification can open it directly. */
  | { name: "terminal"; sessionId: string }
  /** The places file browsing starts from. */
  | { name: "files" }
  | { name: "dir"; path: string }
  /** A file, scrolled to `line` when one is given (from a path tapped in a terminal). */
  | { name: "file"; path: string; line: number | null }
  /** Every repository on the Mac. */
  | { name: "git" }
  /** One repository's changed files, by the path of its working tree. */
  | { name: "repo"; repo: string }
  /** One changed file's diff. `file` is relative to the repository. */
  | { name: "diff"; repo: string; file: string }
  /** One commit of a repository: its message and the files it changed. */
  | { name: "commit"; repo: string; commit: string }
  /** One file's diff in one commit. */
  | { name: "commitFile"; repo: string; commit: string; file: string }
  /** The previews the Mac runs. */
  | { name: "previews" }
  /** One preview, shown in the viewer. */
  | { name: "preview"; id: string }
  | { name: "account" };

export type Area = "terminals" | "files" | "git" | "previews" | "account";

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
    case "commit":
    case "commitFile":
      return "git";
    case "previews":
    case "preview":
      return "previews";
    case "account":
      return "account";
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "account") return { name: "account" };
  if (path === "git") return { name: "git" };
  if (path === "previews") return { name: "previews" };
  if (path.startsWith("p/")) {
    const id = path.slice(2);
    return isPreviewId(id) ? { name: "preview", id } : { name: "previews" };
  }
  if (path.startsWith("git/r/")) return parseRepoRoute(path.slice(5));
  if (path === "files") return { name: "files" };
  if (path.startsWith("tab/")) return { name: "tab", tabId: decodeURIComponent(path.slice(4)) };
  if (path.startsWith("t/") && path.length > 2) {
    return { name: "terminal", sessionId: decodeURIComponent(path.slice(2)) };
  }
  if (path.startsWith("dir/")) {
    const decoded = decodePath(path.slice(3));
    return decoded === null ? { name: "files" } : { name: "dir", path: decoded };
  }
  if (path.startsWith("file/")) {
    // A name's own "?" is escaped, so the first one starts the query.
    const mark = path.indexOf("?");
    const decoded = decodePath(path.slice(4, mark === -1 ? undefined : mark));
    const line = mark === -1 ? null : Number(/(?:^|&)l=(\d+)/.exec(path.slice(mark + 1))?.[1]);
    if (decoded === null) return { name: "files" };
    return { name: "file", path: decoded, line: line !== null && line > 0 ? line : null };
  }
  return { name: "workspace" };
}

/**
 * `<repository path>`, with `?f=<file>` for a changed file, `?c=<commit>` for a commit, or
 * `?c=<commit>&f=<file>` for a file in a commit, each of them escaped.
 */
function parseRepoRoute(rest: string): Route {
  const mark = rest.indexOf("?");
  const repo = decodePath(mark === -1 ? rest : rest.slice(0, mark));
  if (repo === null) return { name: "git" };
  if (mark === -1) return { name: "repo", repo };
  let commit: string | null = null;
  let file: string | null = null;
  try {
    for (const part of rest.slice(mark + 1).split("&")) {
      if (part.startsWith("c=")) commit = decodeURIComponent(part.slice(2));
      else if (part.startsWith("f=")) file = decodeURIComponent(part.slice(2));
    }
  } catch {
    return { name: "repo", repo };
  }
  if (file !== null && !isValidRepoPath(file)) return { name: "repo", repo };
  if (commit === null) return file === null ? { name: "repo", repo } : { name: "diff", repo, file };
  if (!isCommitId(commit)) return { name: "repo", repo };
  return file === null
    ? { name: "commit", repo, commit }
    : { name: "commitFile", repo, commit, file };
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
  previews: "#/previews",
  preview: (id: string) => `#/p/${id}`,
  repo: (repo: string) => `#/git/r${encodePath(repo)}`,
  diff: (repo: string, file: string) => `#/git/r${encodePath(repo)}?f=${encodeURIComponent(file)}`,
  commit: (repo: string, commit: string) => `#/git/r${encodePath(repo)}?c=${commit}`,
  commitFile: (repo: string, commit: string, file: string) =>
    `#/git/r${encodePath(repo)}?c=${commit}&f=${encodeURIComponent(file)}`,
  files: "#/files",
  tab: (tabId: string) => `#/tab/${encodeURIComponent(tabId)}`,
  terminal: (sessionId: string) => `#/t/${encodeURIComponent(sessionId)}`,
  dir: (path: string) => `#/dir${encodePath(path)}`,
  file: (path: string, line: number | null = null) =>
    `#/file${encodePath(path)}${line === null ? "" : `?l=${line}`}`,
};

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  if (window.location.hash === hash) return;
  if (options.replace) {
    window.location.replace(hash);
  } else {
    window.location.hash = hash;
  }
}
