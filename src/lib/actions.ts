import type { TabCreateResult } from "@shared/protocol";
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
