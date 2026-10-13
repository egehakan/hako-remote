import type { Tab } from "@shared/protocol";
import { createContext, use } from "react";

export type WorkspaceActions = {
  /** False while the Mac cannot be reached, so buttons that need it can say so. */
  canAct: boolean;
  /** The folder id a new tab is being opened in, `"loose"` for one outside folders, or null. */
  creatingIn: string | null;
  openTab: (tab: Tab) => void;
  newTab: (folderId?: string) => void;
  askToClose: (tab: Tab) => void;
};

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);

export function useWorkspaceActions(): WorkspaceActions {
  const actions = use(WorkspaceActionsContext);
  if (!actions) throw new Error("WorkspaceActionsContext is missing");
  return actions;
}
