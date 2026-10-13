import { useSyncExternalStore } from "react";
import { type ConnectionSnapshot, relay } from "./connection";
import { type WorkspaceSnapshot, workspaceStore } from "./workspace";

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(relay.subscribe, relay.getSnapshot);
}

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot);
}
