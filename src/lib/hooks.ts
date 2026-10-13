import { useSyncExternalStore } from "react";
import { type ConnectionSnapshot, relay } from "./connection";
import { type NotificationsSnapshot, notifications } from "./notifications";
import { type WorkspaceSnapshot, workspaceStore } from "./workspace";

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(relay.subscribe, relay.getSnapshot);
}

export function useWorkspace(): WorkspaceSnapshot {
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot);
}

export function useNotifications(): NotificationsSnapshot {
  return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
}

const WIDE = "(min-width: 48rem) and (min-height: 30rem)";

function subscribeWide(listener: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** True where a list and a detail view fit side by side: the `wide` variant of the stylesheet. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}
