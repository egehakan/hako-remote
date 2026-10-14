// A folder picked in a desktop browser, put on the Mac as it was: its directories made with
// `fs.mkdir`, parents first, and then each file uploaded into its own.

import { relay } from "@/lib/connection";
import { describeOperationFailure, trackOperation } from "@/lib/files/operations";
import { joinPath } from "@/lib/files/paths";
import { refreshListing } from "@/lib/files/store";
import { uploadFiles } from "@/lib/transfers/actions";

export type FolderPick = {
  /** The picked folder's own name. */
  name: string;
  /** Every directory below it that holds a file, relative to it, parents before children. */
  directories: string[];
  files: { file: File; directory: string }[];
};

/** Reads what a folder picker handed over. Null when it held no files. */
export function readFolderPick(files: readonly File[]): FolderPick | null {
  const directories = new Set<string>();
  const placed: FolderPick["files"] = [];
  let name: string | null = null;
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    if (parts.length < 2) continue;
    name ??= parts[0];
    if (parts[0] !== name) continue;
    const inner = parts.slice(1, -1);
    for (let depth = 1; depth <= inner.length; depth++) {
      directories.add(inner.slice(0, depth).join("/"));
    }
    placed.push({ file, directory: inner.join("/") });
  }
  if (name === null || placed.length === 0) return null;
  const ordered = [...directories].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  return { name, directories: ordered, files: placed };
}

/** Makes the folder as `name` inside `destination`, its directories, and queues its files. */
export async function uploadFolder(
  destination: string,
  pick: FolderPick,
  name: string,
): Promise<void> {
  const top = joinPath(destination, name);
  const count = pick.directories.length + 1;
  const id = trackOperation.begin(
    "folder-upload",
    `Making ${count === 1 ? "the folder" : `${count} folders`} for “${name}”`,
  );
  try {
    await relay.request("fs.mkdir", { path: top });
    for (const directory of pick.directories) {
      let path = top;
      for (const part of directory.split("/")) path = joinPath(path, part);
      await relay.request("fs.mkdir", { path });
    }
  } catch (error) {
    trackOperation.failed(id, describeOperationFailure(error));
    refreshListing(destination);
    return;
  }
  refreshListing(destination);
  trackOperation.done(
    id,
    `Made “${name}”. Its ${pick.files.length.toLocaleString()} ${
      pick.files.length === 1 ? "file follows" : "files follow"
    } one at a time.`,
  );
  const byDirectory = new Map<string, File[]>();
  for (const { file, directory } of pick.files) {
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
  }
  for (const [directory, files] of byDirectory) {
    let path = top;
    for (const part of directory === "" ? [] : directory.split("/")) path = joinPath(path, part);
    uploadFiles(path, files);
  }
}
