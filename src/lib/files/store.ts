// What the Mac has said about its files: the roots and every directory looked at, kept so that
// going back shows a list at once while a fresh one is fetched.

import type { ErrorCode, FsListResult, FsRootsResult } from "@shared/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";
import { setHomeDirectory } from "@/lib/paths";

export type FsError = { code: ErrorCode | "disconnected"; message: string };

export type Loadable<T> = {
  data: T | null;
  error: FsError | null;
  loading: boolean;
};

const IDLE: Loadable<never> = { data: null, error: null, loading: false };
const ROOTS = "roots";

const cache = new Map<string, Loadable<unknown>>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function put(key: string, value: Loadable<unknown>): void {
  cache.set(key, value);
  for (const listener of listeners) listener();
}

export function toFsError(error: unknown): FsError {
  if (error instanceof RpcFailure) return { code: error.code, message: error.message };
  return { code: "failed", message: "" };
}

function load(key: string): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const before = cache.get(key) ?? IDLE;
  put(key, { ...before, loading: true });
  const request =
    key === ROOTS
      ? relay.request<FsRootsResult>("fs.roots")
      : relay.request<FsListResult>("fs.list", { path: key.slice(1) });
  const done = request
    .then(
      (data) => {
        if (key === ROOTS) setHomeDirectory((data as FsRootsResult).home ?? null);
        put(key, { data, error: null, loading: false });
      },
      // A list already on screen stays there under the error, which says it may be out of date.
      (error) => put(key, { data: before.data, error: toFsError(error), loading: false }),
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
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
    if (key !== null && online) void load(key);
  }, [key, online]);
  const reload = useCallback(() => {
    if (key !== null) void load(key);
  }, [key]);
  return { ...state, reload };
}

export function useRoots(): Loadable<FsRootsResult> & { reload: () => void } {
  return useResource<FsRootsResult>(ROOTS);
}

export function useListing(path: string | null): Loadable<FsListResult> & { reload: () => void } {
  return useResource<FsListResult>(path === null ? null : `:${path}`);
}

/** Reads a directory again if it has been looked at, after something in it was changed from here. */
export function refreshListing(path: string): void {
  if (cache.has(`:${path}`)) void load(`:${path}`);
}

// The roots follow the workspace.
relay.on("workspace.changed", () => {
  if (cache.has(ROOTS)) void load(ROOTS);
});

export function clearFiles(): void {
  cache.clear();
  setHomeDirectory(null);
  for (const listener of listeners) listener();
}

// Choices this device remembers.

export type FilesPrefs = {
  showHidden: boolean;
  /** Soft wrap in the file view; null follows the kind of file (prose wraps, code does not). */
  wrap: boolean | null;
  /** The last directory visited under each root, by the root's path. */
  last: Record<string, string>;
};

const STORAGE_KEY = "hako.files.v1";
const MAX_REMEMBERED = 40;

function readPrefs(): FilesPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<FilesPrefs>;
    const last: Record<string, string> = {};
    for (const [root, path] of Object.entries(stored.last ?? {})) {
      if (typeof path === "string") last[root] = path;
    }
    return {
      showHidden: stored.showHidden === true,
      wrap: typeof stored.wrap === "boolean" ? stored.wrap : null,
      last,
    };
  } catch {
    return { showHidden: false, wrap: null, last: {} };
  }
}

let prefs = readPrefs();
const prefListeners = new Set<() => void>();

export const filesPrefs = {
  subscribe(listener: () => void): () => void {
    prefListeners.add(listener);
    return () => prefListeners.delete(listener);
  },
  get: (): FilesPrefs => prefs,
  set(change: Partial<FilesPrefs>): void {
    prefs = { ...prefs, ...change };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Private browsing or a full disk: the choice still holds until the page is closed.
    }
    for (const listener of prefListeners) listener();
  },
  /** Notes where the owner is under a root, so the root opens there next time. */
  remember(root: string, path: string): void {
    if (prefs.last[root] === path) return;
    const last = { ...prefs.last };
    delete last[root];
    last[root] = path;
    const keys = Object.keys(last);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete last[key];
    filesPrefs.set({ last });
  },
};

export function useFilesPrefs(): FilesPrefs {
  return useSyncExternalStore(filesPrefs.subscribe, filesPrefs.get);
}
