// What the Mac has said about its repositories, and what is being done to them from here. The list
// and each repository's changed files are kept so that going back shows them at once while fresh
// ones are fetched.

import { GIT_REPOS_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "@shared/git";
import type {
  ErrorCode,
  GitChangedEvent,
  GitCommitResult,
  GitDiscardResult,
  GitFile,
  GitPullResult,
  GitPushResult,
  GitRepo,
  GitReposResult,
  GitStatusResult,
} from "@shared/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";

export type GitError = { code: ErrorCode | "disconnected"; message: string };

export type Loadable<T> = {
  data: T | null;
  error: GitError | null;
  loading: boolean;
};

export type ActionKind = "commit" | "push" | "pull" | "discard";

/** The last thing done to a repository from here, for as long as it is worth showing. */
export type Activity = {
  kind: ActionKind;
  state: "running" | "done" | "failed";
  /** One line for the repository's row. */
  summary: string;
  /** What git printed, or what the Mac said instead. */
  output: string;
  code: GitError["code"] | null;
  at: number;
};

const IDLE: Loadable<never> = { data: null, error: null, loading: false };
const REPOS = "repos";
const statusKey = (repo: string) => `status:${repo}`;

const cache = new Map<string, Loadable<unknown>>();
const inFlight = new Map<string, Promise<void>>();
/** How many screens are showing each key right now. */
const shown = new Map<string, number>();
const activities = new Map<string, Activity>();
/** Goes up whenever a repository's files may have changed, so an open diff knows to look again. */
const epochs = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function put(key: string, value: Loadable<unknown>): void {
  cache.set(key, value);
  emit();
}

export function toGitError(error: unknown): GitError {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message };
  return { code: "failed", message: "" };
}

function load(key: string): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const before = cache.get(key) ?? IDLE;
  put(key, { ...before, loading: true });
  const request =
    key === REPOS
      ? relay.request<GitReposResult>("git.repos", {}, GIT_REPOS_TIMEOUT_MS)
      : relay.request<GitStatusResult>("git.status", { repo: key.slice(7) });
  const done = request
    .then(
      (data) => {
        put(key, { data, error: null, loading: false });
        if (key !== REPOS) putRepo((data as GitStatusResult).repo);
      },
      // What is already on screen stays there under the error, which says it may be out of date.
      (error) => put(key, { data: before.data, error: toGitError(error), loading: false }),
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
}

/** Puts what the Mac just said about one repository into the list, which may be older. */
function putRepo(repo: GitRepo): void {
  const list = cache.get(REPOS) as Loadable<GitReposResult> | undefined;
  if (!list?.data) return;
  const index = list.data.repos.findIndex((candidate) => candidate.path === repo.path);
  if (index === -1) return;
  const repos = list.data.repos.with(index, { ...repo, root: list.data.repos[index].root });
  put(REPOS, { ...list, data: { repos } });
}

function useResource<T>(key: string | null): Loadable<T> & { reload: () => void } {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const state = useSyncExternalStore(
    subscribe,
    () => (key === null ? IDLE : (cache.get(key) ?? IDLE)) as Loadable<T>,
  );
  // Asks when the screen opens and again whenever the Mac comes back.
  useEffect(() => {
    if (key === null) return;
    shown.set(key, (shown.get(key) ?? 0) + 1);
    if (online) void load(key);
    return () => {
      const left = (shown.get(key) ?? 1) - 1;
      if (left > 0) shown.set(key, left);
      else shown.delete(key);
    };
  }, [key, online]);
  const reload = useCallback(() => {
    if (key !== null) void load(key);
  }, [key]);
  return { ...state, reload };
}

export function useRepos(): Loadable<GitReposResult> & { reload: () => void } {
  return useResource<GitReposResult>(REPOS);
}

export function useRepoStatus(
  repo: string | null,
): Loadable<GitStatusResult> & { reload: () => void } {
  return useResource<GitStatusResult>(repo === null ? null : statusKey(repo));
}

/** One repository as the list has it, for a screen that was opened by its address. */
export function useRepo(path: string | null): GitRepo | null {
  return useSyncExternalStore(subscribe, () => {
    if (path === null) return null;
    const status = cache.get(statusKey(path)) as Loadable<GitStatusResult> | undefined;
    const list = cache.get(REPOS) as Loadable<GitReposResult> | undefined;
    const listed = list?.data?.repos.find((repo) => repo.path === path) ?? null;
    // The list knows which folder a repository belongs to; a status may be the newer of the two.
    return listed ?? status?.data?.repo ?? null;
  });
}

export function useActivity(repo: string | null): Activity | null {
  return useSyncExternalStore(subscribe, () =>
    repo === null ? null : (activities.get(repo) ?? null),
  );
}

export function useEpoch(repo: string): number {
  return useSyncExternalStore(subscribe, () => epochs.get(repo) ?? 0);
}

/** Looks again at everything on screen, and forgets what is not, so that it is fetched when opened. */
function refresh(repo: string | null): void {
  for (const key of [...cache.keys()]) {
    if (key !== REPOS && repo !== null && key !== statusKey(repo)) continue;
    if (shown.has(key)) void load(key);
    else if (key !== REPOS) cache.delete(key);
  }
  if (repo === null) for (const path of epochs.keys()) epochs.set(path, epochs.get(path)! + 1);
  else epochs.set(repo, (epochs.get(repo) ?? 0) + 1);
  emit();
}

// The Mac may say when a repository changed. Several changes in a row are one look.
let changedTimer: number | undefined;
let changedRepos: Set<string> | null = new Set();
relay.on("git.changed", (data) => {
  const repo = (data as Partial<GitChangedEvent> | null)?.repo;
  if (typeof repo === "string") changedRepos?.add(repo);
  else changedRepos = null;
  window.clearTimeout(changedTimer);
  changedTimer = window.setTimeout(() => {
    const repos = changedRepos;
    changedRepos = new Set();
    if (repos === null) refresh(null);
    else for (const path of repos) if (activities.get(path)?.state !== "running") refresh(path);
  }, 400);
});

// The folders decide which repositories there are.
relay.on("workspace.changed", () => {
  if (shown.has(REPOS)) void load(REPOS);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const { link, agent } = relay.getSnapshot();
  if (link === "open" && agent?.online === true) refresh(null);
});

export function clearGit(): void {
  cache.clear();
  activities.clear();
  epochs.clear();
  drafts.clear();
  emit();
}

// Doing things

const DONE_SHOWN_MS = 8_000;

function setActivity(repo: string, activity: Activity | null): void {
  if (activity === null) activities.delete(repo);
  else activities.set(repo, activity);
  emit();
}

export function dismissActivity(repo: string): void {
  if (activities.get(repo)?.state !== "running") setActivity(repo, null);
}

function failureSummary(kind: ActionKind, error: GitError): string {
  const what = { commit: "Commit", push: "Push", pull: "Pull", discard: "Discard" }[kind];
  switch (error.code) {
    case "timeout":
      return `${what}: your Mac hasn’t answered yet`;
    case "disconnected":
    case "agent_offline":
      return `${what}: the connection dropped`;
    case "busy":
      return `${what} is waiting: git is busy in this repository`;
    default:
      return `${what} failed`;
  }
}

export type Outcome<T> = { ok: true; result: T } | { ok: false; error: GitError };

async function act<T extends { repo: GitRepo }>(
  repo: string,
  kind: ActionKind,
  running: string,
  request: () => Promise<T>,
  done: (result: T) => { summary: string; output: string },
): Promise<Outcome<T>> {
  const at = Date.now();
  setActivity(repo, { kind, state: "running", summary: running, output: "", code: null, at });
  let outcome: Outcome<T>;
  try {
    const result = await request();
    putRepo(result.repo);
    setActivity(repo, { kind, state: "done", ...done(result), code: null, at });
    window.setTimeout(() => {
      const current = activities.get(repo);
      if (current?.at === at && current.state === "done") setActivity(repo, null);
    }, DONE_SHOWN_MS);
    outcome = { ok: true, result };
  } catch (failure) {
    const error = toGitError(failure);
    setActivity(repo, {
      kind,
      state: "failed",
      summary: failureSummary(kind, error),
      output: error.message,
      code: error.code,
      at,
    });
    outcome = { ok: false, error };
  }
  // A command that failed may have changed things too: a pull that stopped at a conflict has.
  refresh(repo);
  if (shown.has(REPOS)) void load(REPOS);
  return outcome;
}

export function commit(repo: string, message: string): Promise<Outcome<GitCommitResult>> {
  return act(
    repo,
    "commit",
    "Committing…",
    () => relay.request<GitCommitResult>("git.commit", { repo, message }, GIT_WRITE_TIMEOUT_MS),
    (result) => ({ summary: `Committed ${result.commit.slice(0, 7)}`, output: result.output }),
  );
}

export function push(repo: GitRepo): Promise<Outcome<GitPushResult>> {
  const publishing = repo.branch !== null && repo.upstream === null;
  return act(
    repo.path,
    "push",
    publishing ? `Publishing ${repo.branch}…` : "Pushing…",
    () => relay.request<GitPushResult>("git.push", { repo: repo.path }, GIT_WRITE_TIMEOUT_MS),
    (result) => ({
      summary: result.published
        ? `Published to ${result.repo.upstream ?? "the remote"}`
        : `Pushed to ${result.repo.upstream ?? "the remote"}`,
      output: result.output,
    }),
  );
}

export function pull(repo: GitRepo): Promise<Outcome<GitPullResult>> {
  return act(
    repo.path,
    "pull",
    "Pulling…",
    () => relay.request<GitPullResult>("git.pull", { repo: repo.path }, GIT_WRITE_TIMEOUT_MS),
    (result) => ({
      summary: /already up to date/i.test(result.output)
        ? "Already up to date"
        : `Pulled from ${result.repo.upstream ?? "the remote"}`,
      output: result.output,
    }),
  );
}

export function discard(repo: string, file: GitFile | null): Promise<Outcome<GitDiscardResult>> {
  const name = file === null ? null : file.path.slice(file.path.lastIndexOf("/") + 1);
  return act(
    repo,
    "discard",
    "Discarding…",
    () =>
      relay.request<GitDiscardResult>(
        "git.discard",
        file === null ? { repo } : { repo, path: file.path, old_path: file.old_path },
        GIT_WRITE_TIMEOUT_MS,
      ),
    () => ({
      summary: name === null ? "Discarded all changes" : `Discarded ${name}`,
      output: "",
    }),
  );
}

// A commit message survives closing the sheet, a failed commit and a look at a diff.
const drafts = new Map<string, string>();

export const commitDrafts = {
  get: (repo: string): string => drafts.get(repo) ?? "",
  set(repo: string, message: string): void {
    if (message === "") drafts.delete(repo);
    else drafts.set(repo, message);
  },
};

// Choices this device remembers.

export type GitPrefs = {
  /** Soft wrap in a diff; null follows the screen (a phone wraps, a wide screen does not). */
  wrap: boolean | null;
  /** Whether a commit is pushed straight away, as last chosen. */
  pushAfterCommit: boolean;
};

const STORAGE_KEY = "hako.git.v1";

function readPrefs(): GitPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<GitPrefs>;
    return {
      wrap: typeof stored.wrap === "boolean" ? stored.wrap : null,
      pushAfterCommit: stored.pushAfterCommit === true,
    };
  } catch {
    return { wrap: null, pushAfterCommit: false };
  }
}

let prefs = readPrefs();
const prefListeners = new Set<() => void>();

export const gitPrefs = {
  subscribe(listener: () => void): () => void {
    prefListeners.add(listener);
    return () => prefListeners.delete(listener);
  },
  get: (): GitPrefs => prefs,
  set(change: Partial<GitPrefs>): void {
    prefs = { ...prefs, ...change };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Private browsing or a full disk: the choice still holds until the page is closed.
    }
    for (const listener of prefListeners) listener();
  },
};

export function useGitPrefs(): GitPrefs {
  return useSyncExternalStore(gitPrefs.subscribe, gitPrefs.get);
}
