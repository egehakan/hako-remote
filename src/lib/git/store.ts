// What the Mac has said about its repositories, and what is being done to them from here. The list
// and each repository's changed files are kept so that going back shows them at once while fresh
// ones are fetched.

import { GIT_REPOS_TIMEOUT_MS, GIT_SWITCH_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "@shared/git";
import type {
  ErrorCode,
  GitBranchesResult,
  GitChangedEvent,
  GitCommitResult,
  GitDiscardResult,
  GitFile,
  GitMergeAbortResult,
  GitMergeKind,
  GitMergeResult,
  GitPullResult,
  GitPushResult,
  GitRepo,
  GitReposResult,
  GitShowResult,
  GitStatusResult,
  GitSwitchKind,
  GitSwitchResult,
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

export type ActionKind = "commit" | "push" | "pull" | "discard" | "switch" | "merge" | "abort";

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
  /** A command that finished but left something to do, such as a merge that stopped at conflicts. */
  attention?: boolean;
};

const IDLE: Loadable<never> = { data: null, error: null, loading: false };
const REPOS = "repos";
// Every other key names what is asked, then the repository, then anything more, a line each.
const statusKey = (repo: string) => `status\n${repo}`;
const branchesKey = (repo: string) => `branches\n${repo}`;
const showKey = (repo: string, commit: string) => `show\n${repo}\n${commit}`;
const repoOfKey = (key: string) => key.split("\n")[1];

const cache = new Map<string, Loadable<unknown>>();
const inFlight = new Map<string, Promise<void>>();
/** How many screens are showing each key right now. */
const shown = new Map<string, number>();
const activities = new Map<string, Activity>();
/** Goes up whenever a repository's files may have changed, so an open diff knows to look again. */
const epochs = new Map<string, number>();
/** Goes up when any repository may have changed. */
let everyEpoch = 0;
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
  const [what, repo, commit] = key.split("\n");
  const request: Promise<unknown> =
    key === REPOS
      ? relay.request<GitReposResult>("git.repos", {}, GIT_REPOS_TIMEOUT_MS)
      : what === "status"
        ? relay.request<GitStatusResult>("git.status", { repo })
        : what === "branches"
          ? relay.request<GitBranchesResult>("git.branches", { repo })
          : relay.request<GitShowResult>("git.show", { repo, commit });
  const done = request
    .then(
      (data) => {
        put(key, { data, error: null, loading: false });
        if (what === "status") putRepo((data as GitStatusResult).repo);
        if (what === "branches" || what === "show") noteHistorySupport(true);
      },
      // What is already on screen stays there under the error, which says it may be out of date.
      (failure) => {
        const error = toGitError(failure);
        if (error.code === "not_supported" && (what === "branches" || what === "show")) {
          noteHistorySupport(false);
        }
        put(key, { data: before.data, error, loading: false });
      },
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

/** A repository's branches, for as long as something shows them. */
export function useBranches(
  repo: string | null,
): Loadable<GitBranchesResult> & { reload: () => void } {
  return useResource<GitBranchesResult>(repo === null ? null : branchesKey(repo));
}

/** One commit: its message and the files it changed. */
export function useCommit(
  repo: string | null,
  commit: string | null,
): Loadable<GitShowResult> & { reload: () => void } {
  return useResource<GitShowResult>(
    repo === null || commit === null ? null : showKey(repo, commit),
  );
}

export function useEpoch(repo: string): number {
  return useSyncExternalStore(subscribe, () => (epochs.get(repo) ?? 0) + everyEpoch);
}

/** Looks again at everything on screen, and forgets what is not, so that it is fetched when opened. */
function refresh(repo: string | null): void {
  for (const key of [...cache.keys()]) {
    if (key !== REPOS && repo !== null && repoOfKey(key) !== repo) continue;
    if (shown.has(key)) void load(key);
    else if (key !== REPOS) cache.delete(key);
  }
  if (repo === null) everyEpoch += 1;
  else epochs.set(repo, (epochs.get(repo) ?? 0) + 1);
  emit();
}

/** Reads one repository again because the owner asked: its files, its branches and its graph. */
export function refreshRepo(repo: string): void {
  refresh(repo);
}

// Branches, switching and the graph came after the rest, so a Hako on the Mac may lack them while
// it has everything else. Whichever of their methods answers first says which it is.

export type HistorySupport = "unknown" | "yes" | "no";

let historySupport: HistorySupport = "unknown";
let probingHistory = false;

export function noteHistorySupport(supported: boolean): void {
  const next = supported ? "yes" : "no";
  if (historySupport === next) return;
  historySupport = next;
  emit();
}

function probeHistorySupport(): void {
  if (probingHistory || historySupport !== "unknown") return;
  probingHistory = true;
  relay
    // Not a path, so a Hako that has the method refuses it without looking at any repository.
    .request("git.branches", { repo: "?" })
    .then(
      () => noteHistorySupport(true),
      (failure) => {
        const { code } = toGitError(failure);
        // A Mac that did not get to answer has said nothing about its age: asked again later.
        if (code === "agent_offline" || code === "timeout" || code === "disconnected") return;
        noteHistorySupport(code !== "not_supported");
      },
    )
    .finally(() => {
      probingHistory = false;
    });
}

/** Whether the Hako on the Mac can list branches, switch them and show history. Asks, once. */
export function useHistorySupport(): HistorySupport {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const support = useSyncExternalStore(subscribe, () => historySupport);
  useEffect(() => {
    if (online) probeHistorySupport();
  }, [online, support]);
  return support;
}

// Another Hako may be on the other end after the Mac has been away.
let agentWasUp = false;
relay.subscribe(() => {
  const { link, agent } = relay.getSnapshot();
  const up = link === "open" && agent?.online === true;
  if (up === agentWasUp) return;
  agentWasUp = up;
  if (!up && historySupport !== "unknown") {
    historySupport = "unknown";
    emit();
  }
});

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
    for (const path of repos ?? lingering.keys()) settleLingering(path);
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

// A switch of branch that the relay stopped waiting for is still going on: the Mac gives git four
// minutes, the relay one. Its line stays until the Mac says the repository changed, or until the
// Mac's own limit has passed, and then the repository is read again.
const lingering = new Map<string, number>();
const LINGER_MS = 200_000;

function linger(repo: string, at: number, name: string): void {
  window.clearTimeout(lingering.get(repo));
  lingering.set(
    repo,
    window.setTimeout(() => {
      settleLingering(repo);
      refresh(repo);
    }, LINGER_MS),
  );
  setActivity(repo, {
    kind: "switch",
    state: "running",
    summary: `Still switching to ${name} on your Mac…`,
    output: "",
    code: null,
    at,
  });
}

function settleLingering(repo: string): void {
  const timer = lingering.get(repo);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  lingering.delete(repo);
  if (activities.get(repo)?.kind === "switch") setActivity(repo, null);
}

const clearers = new Set<() => void>();

/** Registers what else has to be forgotten when the owner signs out. */
export function onGitCleared(clear: () => void): void {
  clearers.add(clear);
}

export function clearGit(): void {
  cache.clear();
  for (const timer of lingering.values()) window.clearTimeout(timer);
  lingering.clear();
  activities.clear();
  epochs.clear();
  drafts.clear();
  historySupport = "unknown";
  for (const clear of clearers) clear();
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
  const what = {
    commit: "Commit",
    push: "Push",
    pull: "Pull",
    discard: "Discard",
    switch: "Switch",
    merge: "Merge",
    abort: "Abort merge",
  }[kind];
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

export type Outcome<T> =
  | { ok: true; result: T }
  /** `pending` is true when no answer came but the command is still running on the Mac. */
  | { ok: false; error: GitError; pending?: boolean };

async function act<T extends { repo: GitRepo }>(
  repo: string,
  kind: ActionKind,
  running: string,
  request: () => Promise<T>,
  done: (result: T) => { summary: string; output: string; attention?: boolean },
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

/** What a switch is asked for: a branch there is, or the name of one to make at the current commit. */
export type SwitchTarget = { branch: string; kind: GitSwitchKind };

/** The name the branch has once it is checked out: a remote branch loses its remote. */
function switchedName({ branch, kind }: SwitchTarget): string {
  return kind === "remote" ? branch.slice(branch.indexOf("/") + 1) : branch;
}

export async function switchBranch(
  repo: GitRepo,
  target: SwitchTarget,
): Promise<Outcome<GitSwitchResult & { repo: GitRepo }>> {
  const name = switchedName(target);
  const outcome = await runSwitch(repo, target, name);
  if (!outcome.ok && outcome.error.code === "timeout") {
    linger(repo.path, Date.now(), name);
    return { ok: false, error: outcome.error, pending: true };
  }
  return outcome;
}

function runSwitch(
  repo: GitRepo,
  target: SwitchTarget,
  name: string,
): Promise<Outcome<GitSwitchResult & { repo: GitRepo }>> {
  return act(
    repo.path,
    "switch",
    target.kind === "new" ? `Creating ${name}…` : `Switching to ${name}…`,
    async () => {
      const result = await relay.request<GitSwitchResult>(
        "git.switch",
        { repo: repo.path, branch: target.branch, kind: target.kind },
        GIT_SWITCH_TIMEOUT_MS,
      );
      // The switch says where HEAD is now; what the branch tracks comes with the files.
      const moved: GitRepo = {
        ...repo,
        branch: result.current,
        head: result.head,
        upstream: null,
        ahead: 0,
        behind: 0,
      };
      const status = await relay
        .request<GitStatusResult>("git.status", { repo: repo.path })
        .catch(() => null);
      return { ...result, repo: status?.repo ?? moved };
    },
    (result) => ({
      summary:
        target.kind === "new"
          ? `Created ${result.current ?? name} and switched to it`
          : `Switched to ${result.current ?? name}`,
      output: "",
    }),
  );
}

/** A branch to merge into the current one. */
export type MergeTarget = { branch: string; kind: GitMergeKind };

/** Reads the repository after a command whose answer does not describe it. */
async function repoAfter(repo: GitRepo): Promise<GitRepo> {
  const status = await relay
    .request<GitStatusResult>("git.status", { repo: repo.path })
    .catch(() => null);
  return status?.repo ?? repo;
}

const MERGE_SUMMARY: Record<GitMergeResult["outcome"], (branch: string, count: number) => string> =
  {
    up_to_date: () => "Already up to date",
    fast_forward: (branch) => `Fast-forwarded to ${branch}`,
    merged: (branch) => `Merged ${branch}`,
    conflicts: (branch, count) =>
      `Merging ${branch} stopped at ${count === 1 ? "1 conflict" : `${count} conflicts`}`,
  };

export function mergeBranch(
  repo: GitRepo,
  target: MergeTarget,
): Promise<Outcome<GitMergeResult & { repo: GitRepo }>> {
  return act(
    repo.path,
    "merge",
    `Merging ${target.branch} into ${repo.branch ?? "HEAD"}…`,
    async () => {
      const result = await relay.request<GitMergeResult>(
        "git.merge",
        { repo: repo.path, branch: target.branch, kind: target.kind },
        GIT_WRITE_TIMEOUT_MS,
      );
      return { ...result, repo: await repoAfter(repo) };
    },
    (result) => ({
      summary: MERGE_SUMMARY[result.outcome](target.branch, result.conflicts.length),
      output: result.output,
      attention: result.outcome === "conflicts",
    }),
  );
}

export function abortMerge(
  repo: GitRepo,
): Promise<Outcome<GitMergeAbortResult & { repo: GitRepo }>> {
  return act(
    repo.path,
    "abort",
    "Aborting the merge…",
    async () => {
      const result = await relay.request<GitMergeAbortResult>("git.merge_abort", {
        repo: repo.path,
      });
      return { ...result, repo: await repoAfter(repo) };
    },
    () => ({ summary: "Merge aborted", output: "" }),
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
  /** Whether a repository's changed files and its graph are unfolded. */
  changesOpen: boolean;
  graphOpen: boolean;
};

const STORAGE_KEY = "hako.git.v1";

function readPrefs(): GitPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<GitPrefs>;
    return {
      wrap: typeof stored.wrap === "boolean" ? stored.wrap : null,
      pushAfterCommit: stored.pushAfterCommit === true,
      changesOpen: stored.changesOpen !== false,
      graphOpen: stored.graphOpen !== false,
    };
  } catch {
    return { wrap: null, pushAfterCommit: false, changesOpen: true, graphOpen: true };
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
