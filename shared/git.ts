// The rules of the source control methods in docs/protocol.md that both ends have to agree on.

import type { GitFile, GitFileState } from "./protocol.ts";

/** A unified diff longer than this is answered as `too_large`. */
export const GIT_DIFF_LIMIT_BYTES = 1024 * 1024;
/** `git.status` lists at most this many files. */
export const GIT_STATUS_LIMIT = 2_000;
/** The most of git's output an answer carries: the end of it, where git says what went wrong. */
export const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024;
export const GIT_MESSAGE_LIMIT_BYTES = 64 * 1024;

/** How long the client asks the relay to wait for a commit, push, pull or discard. */
export const GIT_WRITE_TIMEOUT_MS = 300_000;
/** When the agent stops a git command that is still running, well before the client gives up. */
export const GIT_COMMAND_LIMIT_MS = 240_000;
/** Finding every repository can mean walking large folders. */
export const GIT_REPOS_TIMEOUT_MS = 60_000;

/**
 * How long the client asks the relay to wait for a switch of branch. The agent lets git run longer
 * than this, so no answer by then means that the switch is still going on.
 */
export const GIT_SWITCH_TIMEOUT_MS = 60_000;
/** `git.branches` lists at most this many branches. */
export const GIT_BRANCH_LIMIT = 500;
export const GIT_LOG_DEFAULT_LIMIT = 50;
export const GIT_LOG_MAX_LIMIT = 200;
/** A subject line longer than this many characters is cut. */
export const GIT_SUBJECT_LIMIT = 200;
/** The most of a commit's message, after its subject, that `git.show` carries. */
export const GIT_BODY_LIMIT_BYTES = 16 * 1024;

/** How many paths the refusal to commit conflict markers names before it says how many more. */
export const GIT_MARKER_PATHS_SHOWN = 20;

/**
 * True when a file still holds a line that git writes around a conflict: `<<<<<<< `, `=======`
 * exactly, or `>>>>>>> `.
 */
export function hasConflictMarker(text: string): boolean {
  return /^(?:<{7} |={7}\r?$|>{7} )/m.test(text);
}

/** The words of the refusal to commit while files still hold conflict markers. */
export function conflictMarkerMessage(paths: readonly string[]): string {
  const shown = paths.slice(0, GIT_MARKER_PATHS_SHOWN);
  const more = paths.length - shown.length;
  const head =
    paths.length === 1
      ? "This file still has conflict markers. Resolve it, then commit the merge:"
      : "These files still have conflict markers. Resolve them, then commit the merge:";
  return [head, ...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("\n");
}

/**
 * The branch named by the first line of git's prepared merge message ("Merge branch 'x'",
 * "Merge remote-tracking branch 'origin/x' into main"), or null when it names none. Git names a
 * branch that was given by its full ref that way ("Merge branch 'refs/heads/x'"), which is cut
 * back to the branch's own name.
 */
export function mergedBranchOf(firstLine: string): string | null {
  const match = /^Merge (?:remote-tracking )?branch(?:es)? '([^']+)'/.exec(firstLine);
  return match ? match[1].replace(/^refs\/(?:heads|remotes)\//, "") : null;
}

/** True for a commit named the way `git.show` accepts: a full or an abbreviated hash. */
export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{4,64}$/.test(value);
}

export type StatusEntry = Pick<GitFile, "path" | "old_path" | "status">;

export type ParsedStatus = {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusEntry[];
};

/** True for a path inside a repository in the one form the protocol accepts. */
export function isValidRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
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

/**
 * What an ordinary entry (`1 XY …`) is against HEAD, the staged and the unstaged part taken
 * together. Null for a file that was added to the index and then deleted: HEAD never had it and
 * the working tree has not got it, so there is nothing to show.
 */
function ordinaryState(x: string, y: string): GitFileState | null {
  if (x === "A" && y === "D") return null;
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

/**
 * Reads the output of `git status --porcelain=v2 --branch -z --untracked-files=all` into the
 * shapes of `git.status`, with the files in the protocol's order.
 */
export function parseStatus(output: string): ParsedStatus {
  const status: ParsedStatus = {
    head: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  let upstream: string | null = null;
  let tracking = false;
  const byPath = new Map<string, StatusEntry>();
  const put = (entry: StatusEntry) => {
    const earlier = byPath.get(entry.path);
    // Deleted in the index and there again as an untracked file: to the owner, a changed file.
    const reappeared =
      earlier !== undefined &&
      ((earlier.status === "deleted" && entry.status === "untracked") ||
        (earlier.status === "untracked" && entry.status === "deleted"));
    byPath.set(entry.path, reappeared ? { ...entry, status: "modified", old_path: null } : entry);
  };

  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.head = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const counts = /^\+(\d+) -(\d+)$/.exec(value);
        if (counts) {
          tracking = true;
          status.ahead = Number(counts[1]);
          status.behind = Number(counts[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?") {
      // Git names an untracked directory it does not look into (a repository of its own) with a
      // slash at the end, which no path of the protocol has.
      put({ path: record.slice(2).replace(/\/$/, ""), old_path: null, status: "untracked" });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      put({ path: fieldsFrom(record, 10), old_path: null, status: "conflicted" });
    } else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const state = ordinaryState(record[2], record[3]);
      if (state !== null) put({ path: fieldsFrom(record, 8), old_path: null, status: state });
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, and the original path as the next record
      const path = fieldsFrom(record, 9);
      const original = records[++index] ?? "";
      const copied = record[2] === "C" || record[3] === "C";
      if (record[3] === "D") {
        // Renamed in the index and deleted since: what is left is that the old file is gone.
        if (!copied) put({ path: original, old_path: null, status: "deleted" });
      } else if (copied) {
        put({ path, old_path: null, status: "added" });
      } else {
        put({ path, old_path: original, status: "renamed" });
      }
    }
  }

  // An upstream that is configured but no longer exists gives no counts, and is as good as none.
  status.upstream = tracking ? upstream : null;
  status.files = [...byPath.values()].sort((a, b) => byCodePoint(a.path, b.path));
  return status;
}

/** Everything after the first `count` space-separated fields: a path, which may hold spaces. */
function fieldsFrom(record: string, count: number): string {
  let at = 0;
  for (let field = 0; field < count; field++) at = record.indexOf(" ", at) + 1;
  return record.slice(at);
}

export type NumstatEntry = { additions: number | null; deletions: number | null; binary: boolean };

/** Reads `git diff --numstat -z` into counts by path (the new path, for a rename). */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const counts = new Map<string, NumstatEntry>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[index]);
    if (!match) continue;
    let path = match[3];
    if (path === "") {
      // A rename: the old and the new path follow as records of their own.
      path = records[index + 2] ?? "";
      index += 2;
    }
    const binary = match[1] === "-";
    counts.set(path, {
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
      binary,
    });
  }
  return counts;
}
