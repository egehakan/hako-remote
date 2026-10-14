// The downloads a Mac browser session made, as the phone lists them (docs/protocol.md, "Mac
// browser", Downloads). A download the Mac stops telling the phone about is given up on.

import type { BrowserDownload, DownloadState } from "../../../shared/browser.ts";

/** How long a download may go without word from the Mac before the phone stops waiting for it. */
export const DOWNLOAD_STALL_MS = 10 * 60_000;

export type DownloadPhase = DownloadState | "stalled";
export type DownloadItem = BrowserDownload & {
  id: number;
  phase: DownloadPhase;
  updatedAt: number;
};

/** An event's state; older apps send only `done`. */
export function stateOf(event: BrowserDownload): DownloadState {
  switch (event.state) {
    case "progress":
    case "done":
    case "cancelled":
    case "failed":
      return event.state;
    default:
      return event.done ? "done" : "progress";
  }
}

const unfinished = (item: DownloadItem) => item.phase === "progress" || item.phase === "stalled";

/**
 * The list after an event: it updates the newest unfinished download it is about (by path, or by
 * name, since a finished file may have moved), or starts a new one with `id`.
 */
export function mergeDownload(
  items: DownloadItem[],
  event: BrowserDownload,
  id: number,
  now: number,
): DownloadItem[] {
  const phase = stateOf(event);
  let index = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (unfinished(item) && (item.path === event.path || item.name === event.name)) {
      index = i;
      break;
    }
  }
  if (index === -1) return [...items, { ...event, id, phase, updatedAt: now }];
  const before = items[index];
  const next = [...items];
  next[index] = {
    ...event,
    // A progress event may not know the size yet that an earlier one did.
    size: event.size >= 0 ? event.size : before.size,
    id: before.id,
    phase,
    updatedAt: now,
  };
  return next;
}

/** The list with every download the Mac has not mentioned for too long given up on. */
export function markStalled(items: DownloadItem[], now: number): DownloadItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.phase !== "progress" || now - item.updatedAt < DOWNLOAD_STALL_MS) return item;
    changed = true;
    return { ...item, phase: "stalled" as const };
  });
  return changed ? next : items;
}

/** When the next download is due to be given up on, or null when none is waiting. */
export function nextStallAt(items: DownloadItem[]): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (item.phase !== "progress") continue;
    const due = item.updatedAt + DOWNLOAD_STALL_MS;
    if (next === null || due < next) next = due;
  }
  return next;
}
