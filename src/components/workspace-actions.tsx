import type { Tab } from "@shared/protocol";
import { createContext, use } from "react";

export type WorkspaceActions = {
  /** False while the Mac cannot be reached, so buttons that need it can say so. */
  canAct: boolean;
  /** The folder id a new tab is being opened in, `"loose"` for one outside folders, or null. */
  creatingIn: string | null;
  /** Brings a tab to the front on the Mac. The link that calls it does the navigating. */
  openTab: (tab: Tab) => void;
  newTab: (folderId?: string) => void;
  askToClose: (tab: Tab) => void;
  /** The folder that has just been added from here, which the list points out for a moment. */
  arrivedFolderId: string | null;
  /** What went wrong with the last action, in words for the owner, until it is dismissed. */
  notice: string | null;
  dismissNotice: () => void;
};

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);

export function useWorkspaceActions(): WorkspaceActions {
  const actions = use(WorkspaceActionsContext);
  if (!actions) throw new Error("WorkspaceActionsContext is missing");
  return actions;
}
