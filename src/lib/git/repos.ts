// How repositories and their files are sorted, grouped and named for the owner.

import type { GitFile, GitFileState, GitRepo } from "../../../shared/protocol.ts";

export type RepoGroup = { id: "changed" | "sync" | "quiet"; title: string; repos: GitRepo[] };

/** True for a repository with something to commit, or stopped in the middle of a merge or the like. */
export function hasWork(repo: GitRepo): boolean {
  return repo.changed > 0 || repo.operation !== null;
}

/** True for a branch that exists only on the Mac: pushing it publishes it. */
export function isUnpublished(repo: GitRepo): boolean {
  return repo.branch !== null && repo.upstream === null;
}

function groupOf(repo: GitRepo): RepoGroup["id"] {
  if (hasWork(repo)) return "changed";
  return repo.ahead > 0 || repo.behind > 0 ? "sync" : "quiet";
}

const TITLES: Record<RepoGroup["id"], string> = {
  changed: "With changes",
  sync: "To push or pull",
  quiet: "Nothing to do",
};

const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The repositories that match what was typed, those that need the owner first. `folderNames` gives
 * each folder's name by its directory, so a repository can be found by the folder it is in.
 */
export function groupRepos(
  repos: readonly GitRepo[],
  needle: string,
  folderNames: ReadonlyMap<string, string> = new Map(),
): RepoGroup[] {
  const wanted = needle.trim().toLowerCase();
  const matching =
    wanted === ""
      ? repos
      : repos.filter((repo) =>
          [repo.name, repo.branch ?? "", folderNames.get(repo.root) ?? "", repo.path].some((text) =>
            text.toLowerCase().includes(wanted),
          ),
        );
  return (["changed", "sync", "quiet"] as const)
    .map((id) => ({
      id,
      title: TITLES[id],
      repos: matching
        .filter((repo) => groupOf(repo) === id)
        .toSorted((a, b) => NAMES.compare(a.name, b.name) || (a.path < b.path ? -1 : 1)),
    }))
    .filter((group) => group.repos.length > 0);
}

/** The branch as a row says it: its name, or the commit a detached HEAD is at. */
export function branchLabel(repo: GitRepo): string {
  if (repo.branch !== null) return repo.branch;
  return repo.head === null ? "no commits yet" : `detached at ${repo.head.slice(0, 7)}`;
}

export const STATE_LABELS: Record<GitFileState, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflicted: "In conflict",
};

/** The single letter a file's status is marked with, as other git tools mark it. */
export const STATE_LETTERS: Record<GitFileState, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

const COUNT_ORDER: GitFileState[] = [
  "conflicted",
  "modified",
  "added",
  "untracked",
  "renamed",
  "deleted",
];
const COUNT_WORDS: Record<GitFileState, string> = {
  conflicted: "in conflict",
  modified: "modified",
  added: "added",
  untracked: "untracked",
  renamed: "renamed",
  deleted: "deleted",
};

/** "3 modified, 2 new, 1 deleted": what a commit or a discard is about to touch. */
export function summarizeFiles(files: readonly Pick<GitFile, "status">[]): string {
  return COUNT_ORDER.map((state) => {
    const count = files.filter((file) => file.status === state).length;
    return count === 0 ? null : `${count} ${COUNT_WORDS[state]}`;
  })
    .filter((part) => part !== null)
    .join(", ");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export type Explained = { title: string; hint: string | null };

/**
 * Says in the owner's words what git's output most likely means. A reading aid only: the output
 * itself is always shown, and nothing is decided from this.
 */
export function explainFailure(
  kind: "commit" | "push" | "pull" | "discard",
  code: string | null,
  output: string,
): Explained {
  if (code === "timeout") {
    return {
      title: "Your Mac hasn’t answered yet",
      hint: "The command may still be running there. Refresh in a moment to see how it ended; nothing is tried again by itself.",
    };
  }
  if (code === "disconnected" || code === "agent_offline") {
    return {
      title: "The connection dropped",
      hint: "The command may have finished on your Mac all the same. Refresh to see where the repository stands.",
    };
  }
  if (code === "busy") {
    return {
      title: "Git is busy in this repository",
      hint: "Another command is still running there. Try again when it has finished.",
    };
  }
  if (code === "not_found") {
    return { title: "This repository is gone", hint: "It was moved or deleted on your Mac." };
  }
  if (
    /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|terminal prompts disabled|Invalid username or (password|token)|HTTP 40[13]|returned error: 40[13]/i.test(
      output,
    )
  ) {
    return {
      title: "Your Mac couldn’t sign in to the remote",
      hint: "Git on your Mac has no working credentials for this remote. Sign in there, in a terminal, and try again.",
    };
  }
  if (kind === "push") {
    if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(output)) {
      return {
        title: "Push rejected",
        hint: "The remote has commits this branch doesn’t have. Pull first, then push again.",
      };
    }
    if (
      /has no remote|No configured push destination|does not appear to be a git repository/i.test(
        output,
      )
    ) {
      return { title: "Nowhere to push to", hint: null };
    }
    if (/not currently on a branch/i.test(output)) {
      return {
        title: "No branch to push",
        hint: "HEAD is detached: check out a branch on your Mac first.",
      };
    }
    return { title: "Push failed", hint: null };
  }
  if (kind === "pull") {
    if (/CONFLICT|Automatic merge failed|could not apply/i.test(output)) {
      return {
        title: "Pull stopped at conflicts",
        hint: "The files in conflict are marked in the list. Resolve them, then commit to finish; or discard all changes to go back to where you were.",
      };
    }
    if (/would be overwritten/i.test(output)) {
      return {
        title: "Your changes are in the way",
        hint: "The pull would overwrite files you have changed. Commit or discard them first.",
      };
    }
    if (/no tracking information|There is no tracking/i.test(output)) {
      return {
        title: "Nothing to pull from",
        hint: "This branch doesn’t follow a branch on a remote yet. Push publishes it.",
      };
    }
    if (/reconcile divergent branches/i.test(output)) {
      return {
        title: "Git needs to be told how to pull",
        hint: "Both sides have new commits, and git on your Mac isn’t set to merge or to rebase. Set pull.rebase there.",
      };
    }
    if (/not currently on a branch/i.test(output)) {
      return {
        title: "No branch to pull into",
        hint: "HEAD is detached: check out a branch on your Mac first.",
      };
    }
    return { title: "Pull failed", hint: null };
  }
  if (kind === "commit") {
    if (/nothing to commit/i.test(output)) return { title: "Nothing to commit", hint: null };
    if (/Please tell me who you are|user\.email/i.test(output)) {
      return {
        title: "Git doesn’t know who you are",
        hint: "Set user.name and user.email on your Mac, then commit again.",
      };
    }
    return { title: "Commit failed", hint: null };
  }
  return { title: "Discard failed", hint: null };
}
