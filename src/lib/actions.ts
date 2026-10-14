import type { FolderCreateResult, TabCreateResult } from "@shared/protocol";
import { relay } from "./connection";
import { workspaceStore } from "./workspace";

/** Opens a terminal tab, in a folder when one is given, and returns it once it is listed. */
export async function createTab(folderId?: string): Promise<TabCreateResult> {
  const created = await relay.request<TabCreateResult>(
    "tab.create",
    folderId === undefined ? {} : { folder_id: folderId },
  );
  await workspaceStore.refresh();
  return created;
}

export function activateTab(tabId: string): Promise<unknown> {
  return relay.request("tab.activate", { tab_id: tabId });
}

export function closeTab(tabId: string): Promise<unknown> {
  return relay.request("tab.close", { tab_id: tabId });
}

/**
 * Adds a folder for a directory on the Mac, in the window in front there, and returns its id once
 * it is listed. A directory that is already a folder of that window gives that folder's id.
 */
export async function createFolder(directory: string): Promise<string> {
  const created = await relay.request<FolderCreateResult>("folder.create", { directory });
  await workspaceStore.refresh();
  return created.folder_id;
}

/** Gives a tab a title of its own, or with `null` its automatic title back, once it is listed. */
export async function renameTab(tabId: string, title: string | null): Promise<void> {
  await relay.request("tab.rename", { tab_id: tabId, title });
  await workspaceStore.refresh();
}

/** Gives a folder a name of its own, or with `null` its default name back, once it is listed. */
export async function renameFolder(folderId: string, name: string | null): Promise<void> {
  await relay.request("folder.rename", { folder_id: folderId, name });
  await workspaceStore.refresh();
}
