import { isDirectory } from "@shared/files";
import type { FsEntry } from "@shared/protocol";

const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Entries as a list shows them: directories first, then by name the way a person sorts names. */
export function inDisplayOrder(entries: readonly FsEntry[]): FsEntry[] {
  return entries.toSorted(
    (a, b) =>
      Number(isDirectory(b)) - Number(isDirectory(a)) ||
      NAMES.compare(a.name, b.name) ||
      (a.name < b.name ? -1 : 1),
  );
}
