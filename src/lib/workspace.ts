// The workspace as the Mac last reported it, kept current by `workspace.changed`.

import type { AgentStatus, Folder, Pane, Tab, Window, Workspace } from "@shared/protocol";
import { relay } from "./connection";

export type WorkspaceSnapshot = {
  windows: Window[] | null;
  /** Set when the Mac is online but the last `workspace.list` failed. */
  error: string | null;
  /** When `windows` was last answered by the Mac, in milliseconds since the epoch; 0 before. */
  loadedAt: number;
};

const EMPTY: WorkspaceSnapshot = { windows: null, error: null, loadedAt: 0 };

let snapshot: WorkspaceSnapshot = EMPTY;
let inFlight: Promise<void> | null = null;
let stale = false;
const listeners = new Set<() => void>();

function set(next: WorkspaceSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  try {
    do {
      stale = false;
      const result = await relay.request<Workspace>("workspace.list");
      set({ windows: result.windows, error: null, loadedAt: Date.now() });
    } while (stale);
  } catch (error) {
    if (relay.getSnapshot().agent?.online) {
      set({ ...snapshot, error: error instanceof Error ? error.message : "Failed" });
    }
  } finally {
    inFlight = null;
  }
}

/** Resolves once the workspace reflects everything the Mac had announced when it was called. */
function refresh(): Promise<void> {
  // An answer already on its way may predate the change that prompted this call, so ask again after.
  if (inFlight) stale = true;
  else inFlight = load();
  return inFlight;
}

relay.on("workspace.changed", () => void refresh());
relay.on("agent.status", (data) => {
  if ((data as AgentStatus).online) void refresh();
  else set(EMPTY);
});

export const workspaceStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): WorkspaceSnapshot => snapshot,
  refresh,
  clear: () => set(EMPTY),
};

export type TabLocation = { window: Window; tab: Tab; folder: Folder | null };

export function findTab(windows: Window[] | null, tabId: string): TabLocation | null {
  for (const window of windows ?? []) {
    const tab = window.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      const folder = window.folders.find((candidate) => candidate.id === tab.folder_id) ?? null;
      return { window, tab, folder };
    }
  }
  return null;
}

export type TerminalLocation = TabLocation & { pane: Pane; sessionId: string };

/** Every terminal on the Mac, in the order the workspace list shows them. */
export function listTerminals(windows: Window[] | null): TerminalLocation[] {
  const terminals: TerminalLocation[] = [];
  for (const window of windows ?? []) {
    // The list shows a window's folders first and its loose tabs after them.
    const inFolder = (tab: Tab) =>
      window.folders.findIndex((folder) => folder.id === tab.folder_id);
    const ordered = [
      ...window.folders.flatMap((folder) =>
        window.tabs.filter((tab) => tab.folder_id === folder.id),
      ),
      ...window.tabs.filter((tab) => inFolder(tab) === -1),
    ];
    for (const tab of ordered) {
      const folder = window.folders.find((candidate) => candidate.id === tab.folder_id) ?? null;
      for (const pane of tab.panes) {
        if (pane.kind === "terminal" && pane.session_id !== null) {
          terminals.push({ window, tab, folder, pane, sessionId: pane.session_id });
        }
      }
    }
  }
  return terminals;
}

/** The terminal a tab opens with: the focused one, or else its first. */
export function leadTerminal(tab: Tab): Pane | null {
  const terminals = tab.panes.filter(
    (pane) => pane.kind === "terminal" && pane.session_id !== null,
  );
  return terminals.find((pane) => pane.focused) ?? terminals[0] ?? null;
}

const ATTENTION_ORDER = ["waiting", "failed", "working", "done"] as const;

/** The agent state that most needs the owner's eye among a tab's panes, if any. */
export function tabAgent(tab: Tab): Pane["agent"] {
  let best: Pane["agent"] = null;
  for (const pane of tab.panes) {
    if (!pane.agent) continue;
    if (
      !best ||
      ATTENTION_ORDER.indexOf(pane.agent.status) < ATTENTION_ORDER.indexOf(best.status)
    ) {
      best = pane.agent;
    }
  }
  return best;
}
