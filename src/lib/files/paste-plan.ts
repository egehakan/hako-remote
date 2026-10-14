// What a paste asks of the Mac: which items go in which request, with which answer for a name
// that is taken. The owner is asked once for the whole batch, never item by item.

import { MAX_SOURCES, sameNameKey } from "../../../shared/operations.ts";
import type { FsConflictChoice } from "../../../shared/protocol.ts";
import { parentOf } from "./paths.ts";

export type PasteMode = "copy" | "move";

export type PasteItem = { path: string; name: string; isDirectory: boolean };

/** The owner's one answer for every name in the way: keep both, replace, or leave those out. */
export type PasteChoice = "rename" | "replace" | "skip";

export type PasteRequest = { sources: string[]; on_conflict: FsConflictChoice };

export type PastePlan = {
  /** Items whose name is already in the destination, or taken by an earlier item of the batch. */
  conflicts: PasteItem[];
  /** True while there are conflicts and no answer for them. Nothing is sent until there is one. */
  needsChoice: boolean;
  /** What to send, in order. Each holds at most `MAX_SOURCES` items. */
  requests: PasteRequest[];
  /** Items nothing is asked for: moved into the directory they are in, or skipped. */
  untouched: PasteItem[];
};

type PasteInput = {
  mode: PasteMode;
  items: readonly PasteItem[];
  destination: string;
  /** The names in the destination now. */
  existing: readonly string[];
  /** The owner's answer, once given. */
  choice: PasteChoice | null;
};

export function planPaste({ mode, items, destination, existing, choice }: PasteInput): PastePlan {
  const taken = new Set(existing.map(sameNameKey));
  const duplicates: PasteItem[] = [];
  const clean: PasteItem[] = [];
  const conflicts: PasteItem[] = [];
  const untouched: PasteItem[] = [];

  for (const item of items) {
    const home = parentOf(item.path) === destination;
    if (home && mode === "move") {
      // Moving an item onto itself does nothing, so it is not asked for.
      untouched.push(item);
      continue;
    }
    if (home) {
      // A copy into its own directory is a duplicate, which always keeps both.
      duplicates.push(item);
      continue;
    }
    const key = sameNameKey(item.name);
    if (taken.has(key)) conflicts.push(item);
    else clean.push(item);
    taken.add(key);
  }

  const needsChoice = conflicts.length > 0 && choice === null;
  if (needsChoice) return { conflicts, needsChoice, requests: [], untouched };

  const requests: PasteRequest[] = [];
  const add = (group: readonly PasteItem[], onConflict: FsConflictChoice) => {
    for (let start = 0; start < group.length; start += MAX_SOURCES) {
      const sources = group.slice(start, start + MAX_SOURCES).map((item) => item.path);
      requests.push({ sources, on_conflict: onConflict });
    }
  };

  if (conflicts.length === 0) {
    add(clean, "fail");
  } else if (choice === "skip") {
    add(clean, "fail");
    untouched.push(...conflicts);
  } else {
    // The answer is for the names in the way; the others are not in the way, so it changes nothing
    // for them, and they travel in the same request.
    const inOrder = items.filter((item) => clean.includes(item) || conflicts.includes(item));
    add(inOrder, choice === "replace" ? "replace" : "rename");
  }
  add(duplicates, "rename");
  return { conflicts, needsChoice, requests, untouched };
}
