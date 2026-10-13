import type { TabCreateResult } from "@shared/protocol";
import { relay } from "./connection";
import { workspaceStore } from "./workspace";

/** Opens a terminal tab, in a folder when one is given, and returns its id once it is listed. */
export async function createTab(folderId?: string): Promise<string> {
  const created = await relay.request<TabCreateResult>(
    "tab.create",
    folderId === undefined ? {} : { folder_id: folderId },
  );
  await workspaceStore.refresh();
  return created.tab_id;
}

export function activateTab(tabId: string): Promise<unknown> {
  return relay.request("tab.activate", { tab_id: tabId });
}

export function closeTab(tabId: string): Promise<unknown> {
  return relay.request("tab.close", { tab_id: tabId });
}
