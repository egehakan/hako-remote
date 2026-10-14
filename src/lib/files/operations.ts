// What Files changes on the Mac: whether the Hako there can do it at all, the phone's own
// clipboard, and the operations under way with what became of each item.

import { OPERATION_TIMEOUT_MS } from "@shared/operations";
import type {
  FsArchiveResult,
  FsExtractResult,
  FsItemResult,
  FsItemResults,
  FsListResult,
} from "@shared/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { formatSize } from "@/lib/files/format";
import { baseName, parentOf } from "@/lib/files/paths";
import {
  type PasteChoice,
  type PasteItem,
  type PasteMode,
  planPaste,
} from "@/lib/files/paste-plan";
import { refreshListing } from "@/lib/files/store";
import { useConnection } from "@/lib/hooks";
import { tildify } from "@/lib/paths";
import { saveToDevice } from "@/lib/transfers/actions";

// Whether the Mac has the operations of round 1.

export type OpsSupport = "unknown" | "yes" | "no";

let support: OpsSupport = "unknown";
let probing = false;
const supportListeners = new Set<() => void>();

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

function setSupport(next: OpsSupport): void {
  support = next;
  for (const listener of supportListeners) listener();
}

/** Asks once per Mac connection: an app that has round 1 answers a malformed `fs.stat` with `bad_request`. */
function probe(): void {
  if (probing || support !== "unknown" || !isUp()) return;
  probing = true;
  relay
    .request("fs.stat", { path: "?" })
    .then(
      () => setSupport("yes"),
      (error) => {
        if (!(error instanceof RpcFailure)) return;
        if (error.code === "not_supported") setSupport("no");
        else if (error.code === "bad_request") setSupport("yes");
      },
    )
    .finally(() => {
      probing = false;
    });
}

let wasUp = isUp();
relay.subscribe(() => {
  const up = isUp();
  if (up === wasUp) return;
  wasUp = up;
  if (!up && support !== "unknown") setSupport("unknown");
  if (up && supportListeners.size > 0) probe();
});

export function useOpsSupport(): OpsSupport {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const current = useSyncExternalStore(
    (listener) => {
      supportListeners.add(listener);
      return () => supportListeners.delete(listener);
    },
    () => support,
  );
  useEffect(() => {
    if (online) probe();
  }, [online, current]);
  return current;
}

// The clipboard. It is this device's own, kept until it is pasted or cleared, and survives a reload.

export type Clipboard = { mode: PasteMode; items: PasteItem[]; from: string };

const CLIPBOARD_KEY = "hako.files.clipboard.v1";

function readClipboard(): Clipboard | null {
  try {
    const stored = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? "null") as Clipboard | null;
    if (
      stored &&
      (stored.mode === "copy" || stored.mode === "move") &&
      Array.isArray(stored.items) &&
      stored.items.length > 0 &&
      typeof stored.from === "string"
    ) {
      return stored;
    }
  } catch {
    // Unreadable: start empty.
  }
  return null;
}

let clipboard = readClipboard();
const clipboardListeners = new Set<() => void>();

export const fileClipboard = {
  get: (): Clipboard | null => clipboard,
  set(next: Clipboard | null): void {
    clipboard = next;
    try {
      if (next) localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(next));
      else localStorage.removeItem(CLIPBOARD_KEY);
    } catch {
      // Private browsing: it still holds until the page is closed.
    }
    for (const listener of clipboardListeners) listener();
  },
  subscribe(listener: () => void): () => void {
    clipboardListeners.add(listener);
    return () => clipboardListeners.delete(listener);
  },
};

export function useClipboard(): Clipboard | null {
  return useSyncExternalStore(fileClipboard.subscribe, fileClipboard.get);
}

// Operations under way, and what they came to.

export type OperationKind =
  "copy" | "move" | "duplicate" | "trash" | "archive" | "extract" | "folder-upload";

export type Operation = {
  id: number;
  kind: OperationKind;
  /** What is being done, in the owner's words: "Copying 3 items to Notes". */
  title: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  /** Once done: what happened, in a sentence. */
  summary: string | null;
  /** The items that failed, each with what the Mac said. */
  failures: { name: string; message: string }[];
  /** Where a finished operation's result can be seen, such as an unpacked folder. */
  openPath: string | null;
};

let operations: readonly Operation[] = [];
let nextOperation = 1;
const operationListeners = new Set<() => void>();

function setOperations(next: readonly Operation[]): void {
  operations = next;
  for (const listener of operationListeners) listener();
}

function begin(kind: OperationKind, title: string): number {
  const id = nextOperation++;
  setOperations([
    ...operations,
    {
      id,
      kind,
      title,
      state: "running",
      startedAt: Date.now(),
      summary: null,
      failures: [],
      openPath: null,
    },
  ]);
  return id;
}

function finish(id: number, change: Partial<Operation>): void {
  setOperations(operations.map((item) => (item.id === id ? { ...item, ...change } : item)));
}

export function dismissOperation(id: number): void {
  setOperations(operations.filter((item) => item.id !== id));
}

export function useOperations(): readonly Operation[] {
  return useSyncExternalStore(
    (listener) => {
      operationListeners.add(listener);
      return () => operationListeners.delete(listener);
    },
    () => operations,
  );
}

export function clearOperations(): void {
  setOperations([]);
  fileClipboard.set(null);
}

/** Why a whole request failed, in a sentence for the owner. */
export function describeOperationFailure(error: unknown): string {
  if (!(error instanceof RpcFailure)) return "Something went wrong. Try again.";
  switch (error.code) {
    case "agent_offline":
    case "disconnected":
      return "The connection to your Mac broke before it answered. Some items may have been done; refresh to see.";
    case "timeout":
      return "Your Mac didn’t answer in time. Some items may have been done; refresh to see.";
    case "not_supported":
      return "Update Hako on your Mac to use this.";
    case "not_found":
      return error.message || "That folder isn’t there any more on your Mac.";
    case "too_large":
      return error.limit !== null && error.limit > 100_000
        ? `${error.message || "It’s too large."} The limit is ${formatSize(error.limit)}.`
        : error.message || "It’s too large.";
    case "bad_request":
    case "failed":
    case "not_a_directory":
    case "is_a_directory":
    case "permission_denied":
    case "conflict":
    case "git_failed":
    case "busy":
      return error.message || "Your Mac couldn’t do that.";
  }
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * The items that need the owner's eye, with the Mac's words for each. A move between disks that
 * copied an item but could not remove the original answers with both a path and an error.
 */
function failuresOf(results: readonly FsItemResult[]) {
  return results
    .filter((result) => result.error !== null)
    .map((result) => ({
      name: baseName(result.source),
      message:
        result.path !== null
          ? `copied, but the original could not be removed: ${result.error!.message}`
          : result.error!.message,
    }));
}

/** The names in a directory now, read fresh so a paste decides on what is really there. */
export async function namesIn(directory: string): Promise<string[]> {
  const listing = await relay.request<FsListResult>("fs.list", { path: directory });
  return listing.entries.map((entry) => entry.name);
}

const PAST: Record<PasteMode, string> = { copy: "Copied", move: "Moved" };
const DOING: Record<PasteMode, string> = { copy: "Copying", move: "Moving" };

/**
 * Copies or moves items into a directory. `existing` is what is there now; `choice` the owner's
 * answer for names in the way. Returns false, sending nothing, while an answer is needed.
 */
export async function paste(
  mode: PasteMode,
  items: readonly PasteItem[],
  destination: string,
  existing: readonly string[],
  choice: PasteChoice | null,
  options: { duplicate?: boolean } = {},
): Promise<boolean> {
  const plan = planPaste({ mode, items, destination, existing, choice });
  if (plan.needsChoice) return false;
  if (plan.requests.length === 0) {
    if (choice === "skip" && plan.conflicts.length > 0) {
      const id = begin(mode, "");
      finish(id, {
        state: "done",
        summary: `Nothing pasted: ${plural(plan.conflicts.length, "item")} already there left alone.`,
      });
    }
    return true;
  }
  const kind: OperationKind = options.duplicate ? "duplicate" : mode;
  const what = items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item");
  const id = begin(
    kind,
    options.duplicate ? `Duplicating ${what}` : `${DOING[mode]} ${what} to ${tildify(destination)}`,
  );
  const results: FsItemResult[] = [];
  try {
    for (const request of plan.requests) {
      const answer = await relay.request<FsItemResults>(
        mode === "copy" ? "fs.copy" : "fs.move",
        { ...request, destination },
        OPERATION_TIMEOUT_MS,
      );
      results.push(...answer.results);
    }
  } catch (error) {
    finish(id, {
      state: "failed",
      summary: describeOperationFailure(error),
      failures: failuresOf(results),
    });
    return true;
  } finally {
    refreshListing(destination);
    if (mode === "move") {
      for (const from of new Set(items.map((item) => parentOf(item.path) ?? "/"))) {
        refreshListing(from);
      }
    }
  }
  const done = results.filter((result) => result.path !== null).length;
  const failures = failuresOf(results);
  const failed = results.filter((result) => result.path === null).length;
  const skipped = choice === "skip" ? plan.conflicts.length : 0;
  const verb = options.duplicate ? "Duplicated" : PAST[mode];
  const left = skipped > 0 ? ` ${plural(skipped, "item")} already there left alone.` : "";
  const summary =
    failures.length === 0
      ? `${verb} ${done === 1 && items.length === 1 ? what : plural(done, "item")}.${left}`
      : failed === 0
        ? `${verb} ${plural(done, "item")}.${left} Not everything went cleanly:`
        : `${verb} ${done} of ${plural(done + failed, "item")}.${left} Your Mac couldn’t do the rest:`;
  finish(id, { state: failures.length === 0 ? "done" : "failed", summary, failures });
  return true;
}

/** Puts items in the Trash on the Mac. */
export async function moveToTrash(items: readonly PasteItem[]): Promise<void> {
  const what = items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item");
  const id = begin("trash", `Moving ${what} to the Trash`);
  const results: FsItemResult[] = [];
  try {
    for (let start = 0; start < items.length; start += 500) {
      const answer = await relay.request<FsItemResults>(
        "fs.trash",
        { paths: items.slice(start, start + 500).map((item) => item.path) },
        OPERATION_TIMEOUT_MS,
      );
      results.push(...answer.results);
    }
  } catch (error) {
    finish(id, {
      state: "failed",
      summary: describeOperationFailure(error),
      failures: failuresOf(results),
    });
    return;
  } finally {
    for (const from of new Set(items.map((item) => parentOf(item.path) ?? "/"))) {
      refreshListing(from);
    }
  }
  const failures = failuresOf(results);
  const done = results.length - failures.length;
  finish(id, {
    state: failures.length === 0 ? "done" : "failed",
    summary:
      failures.length === 0
        ? `Moved ${items.length === 1 ? what : plural(done, "item")} to the Trash on your Mac`
        : `Moved ${done} of ${plural(results.length, "item")} to the Trash. Your Mac couldn’t move the rest:`,
    failures,
  });
}

/** Zips a directory on the Mac, then fetches the zip to this device. */
export async function downloadFolder(path: string, skipHeavy: boolean): Promise<void> {
  const name = baseName(path);
  const id = begin("archive", `Zipping “${name}” on your Mac`);
  try {
    const result = await relay.request<FsArchiveResult>(
      "fs.archive",
      { path, skip_heavy: skipHeavy },
      OPERATION_TIMEOUT_MS,
    );
    const left = skipHeavy
      ? result.skipped === 0
        ? ", no heavy folders to leave out"
        : `, ${plural(result.skipped, "heavy folder")} left out`
      : "";
    finish(id, {
      state: "done",
      summary: `Zipped “${name}”: ${formatSize(result.size)}${left}. Downloading it now.`,
    });
    saveToDevice(result.path, result.name, result.size);
  } catch (error) {
    finish(id, { state: "failed", summary: describeOperationFailure(error) });
  }
}

/** Unpacks a zip on the Mac into a new folder beside it, or in `destination`. */
export async function extractHere(path: string, destination: string): Promise<void> {
  const id = begin("extract", `Unpacking “${baseName(path)}”`);
  try {
    const result = await relay.request<FsExtractResult>(
      "fs.extract",
      { path, destination },
      OPERATION_TIMEOUT_MS,
    );
    finish(id, {
      state: "done",
      summary: `Unpacked ${plural(result.entries, "item")} into “${baseName(result.path)}”`,
      openPath: result.path,
    });
  } catch (error) {
    finish(id, { state: "failed", summary: describeOperationFailure(error) });
  } finally {
    refreshListing(destination);
  }
}

/** Records an operation that runs elsewhere, such as making a folder tree before an upload. */
export const trackOperation = {
  begin,
  done: (id: number, summary: string) => finish(id, { state: "done", summary }),
  failed: (id: number, summary: string) => finish(id, { state: "failed", summary }),
};
