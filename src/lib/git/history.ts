// A repository's history as the Mac lists it, a page at a time, laid out as a graph while it comes
// in. What was loaded is kept, so going back to a repository shows its graph at once while it is
// read again.

import { GIT_LOG_DEFAULT_LIMIT, GIT_LOG_MAX_LIMIT } from "@shared/git";
import type { GitCommit, GitLogResult } from "@shared/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { relay } from "@/lib/connection";
import { type GraphRow, type GraphState, layoutGraph, startGraph } from "@/lib/git/graph";
import {
  type GitError,
  noteHistorySupport,
  onGitCleared,
  toGitError,
  useEpoch,
} from "@/lib/git/store";
import { useConnection } from "@/lib/hooks";

export type History = {
  commits: GitCommit[];
  /** One row of the graph for each commit, in the same order. */
  rows: GraphRow[];
  hasMore: boolean;
  head: string | null;
  upstream: string | null;
};

export type HistoryState = {
  history: History | null;
  error: GitError | null;
  /** True while the history is read from its start. */
  loading: boolean;
  loadingMore: boolean;
};

type Entry = HistoryState & {
  /** Where the lanes stand below the last row, for the page that follows. */
  graph: GraphState | null;
  /** Goes up with each read from the start, so an answer to an older question is dropped. */
  generation: number;
};

const IDLE: HistoryState = { history: null, error: null, loading: false, loadingMore: false };
/** A read from the start brings back as much as was on screen, but not more than this. */
const REREAD_LIMIT = 1_000;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function put(repo: string, entry: Entry): void {
  entries.set(repo, entry);
  for (const listener of listeners) listener();
}

onGitCleared(() => {
  entries.clear();
  for (const listener of listeners) listener();
});

function entryOf(repo: string): Entry {
  return entries.get(repo) ?? { ...IDLE, graph: null, generation: 0 };
}

function append(before: History | null, graph: GraphState | null, page: GitLogResult) {
  const tips = { head: page.head, upstream: page.upstream };
  const laid = layoutGraph(page.commits, tips, graph ?? startGraph(tips));
  const commits = before ? [...before.commits, ...page.commits] : page.commits;
  const history: History = {
    commits,
    rows: before ? [...before.rows, ...laid.rows] : laid.rows,
    hasMore: page.has_more,
    head: page.head,
    upstream: page.upstream,
  };
  return { history, graph: laid.state };
}

/**
 * What is loaded, brought up to date by the first page alone. That is all it takes while HEAD and
 * the upstream are where they were: the commits are then the same ones in the same order, and only
 * the branches and tags that point at them may have moved. Null when the history itself changed.
 */
function refreshed(before: Entry, page: GitLogResult) {
  const old = before.history;
  if (old === null || before.graph === null) return null;
  if (old.head !== page.head || old.upstream !== page.upstream) return null;
  if (page.commits.length > old.commits.length) return null;
  if (page.commits.some((commit, index) => commit.id !== old.commits[index].id)) return null;
  const history: History = {
    ...old,
    commits: [...page.commits, ...old.commits.slice(page.commits.length)],
    hasMore: old.commits.length > page.commits.length ? old.hasMore : page.has_more,
  };
  return { history, graph: before.graph };
}

/** Reads the history from its start, as far down as it was already shown. */
async function read(repo: string): Promise<void> {
  const before = entryOf(repo);
  const generation = before.generation + 1;
  put(repo, { ...before, loading: true, loadingMore: false, generation });
  const wanted = Math.min(
    Math.max(before.history?.commits.length ?? 0, GIT_LOG_DEFAULT_LIMIT),
    REREAD_LIMIT,
  );
  try {
    let history: History | null = null;
    let graph: GraphState | null = null;
    for (;;) {
      const skip: number = history?.commits.length ?? 0;
      const page: GitLogResult = await relay.request<GitLogResult>("git.log", {
        repo,
        limit: Math.min(wanted - skip, GIT_LOG_MAX_LIMIT),
        skip,
      });
      if (entryOf(repo).generation !== generation) return;
      const kept = history === null ? refreshed(before, page) : null;
      if (kept !== null) {
        ({ history, graph } = kept);
        break;
      }
      ({ history, graph } = append(history, graph, page));
      if (!page.has_more || page.commits.length === 0 || history.commits.length >= wanted) break;
    }
    noteHistorySupport(true);
    put(repo, { history, graph, error: null, loading: false, loadingMore: false, generation });
  } catch (failure) {
    if (entryOf(repo).generation !== generation) return;
    const error = toGitError(failure);
    if (error.code === "not_supported") noteHistorySupport(false);
    // The graph already on screen stays there under the error.
    put(repo, { ...entryOf(repo), error, loading: false });
  }
}

/** Reads the page after the last commit that is loaded. */
async function readMore(repo: string): Promise<void> {
  const before = entryOf(repo);
  if (before.history === null || !before.history.hasMore || before.loading || before.loadingMore) {
    return;
  }
  put(repo, { ...before, loadingMore: true });
  const { generation } = before;
  try {
    const page = await relay.request<GitLogResult>("git.log", {
      repo,
      limit: GIT_LOG_DEFAULT_LIMIT,
      skip: before.history.commits.length,
    });
    const now = entryOf(repo);
    if (now.generation !== generation || now.history !== before.history) return;
    // The branch moved while the page was on its way: what is loaded no longer lines up with it.
    if (page.head !== before.history.head || page.upstream !== before.history.upstream) {
      void read(repo);
      return;
    }
    put(repo, { ...now, ...append(before.history, before.graph, page), loadingMore: false });
  } catch (failure) {
    const now = entryOf(repo);
    if (now.generation !== generation) return;
    put(repo, { ...now, error: toGitError(failure), loadingMore: false });
  }
}

/**
 * One repository's history. It is read when the graph opens, when the Mac comes back, and whenever
 * the repository may have changed; `enabled` is false while nothing shows it.
 */
export function useHistory(
  repo: string,
  enabled: boolean,
): HistoryState & { reload: () => void; loadMore: () => void } {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const epoch = useEpoch(repo);
  const state = useSyncExternalStore(subscribe, () => entries.get(repo) ?? (IDLE as Entry));
  useEffect(() => {
    if (enabled && online) void read(repo);
  }, [repo, enabled, online, epoch]);
  const reload = useCallback(() => void read(repo), [repo]);
  const loadMore = useCallback(() => void readMore(repo), [repo]);
  return {
    history: state.history,
    error: state.error,
    loading: state.loading,
    loadingMore: state.loadingMore,
    reload,
    loadMore,
  };
}
