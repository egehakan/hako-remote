// Whether the Hako on the Mac can add a folder from here. It is asked once each time the Mac comes
// online, so that the action can say so before anybody has picked a directory for nothing.

import { useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";

/** "unknown" until the Mac has answered. */
export type FolderSupport = "unknown" | "yes" | "no";

let support: FolderSupport = "unknown";
let probing = false;
const listeners = new Set<() => void>();

function set(next: FolderSupport): void {
  if (support === next) return;
  support = next;
  for (const listener of listeners) listener();
}

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

function probe(): void {
  if (probing || support !== "unknown" || !isUp()) return;
  probing = true;
  relay
    // Not a path, so an app that has the method refuses it and nothing is added.
    .request("folder.create", { directory: "?" })
    .then(
      () => set("yes"),
      (error) => {
        if (!(error instanceof RpcFailure)) return;
        switch (error.code) {
          case "not_supported":
            set("no");
            break;
          // The Mac did not get to answer, which says nothing about its age: asked again later.
          case "agent_offline":
          case "timeout":
          case "disconnected":
            break;
          case "bad_request":
          case "not_found":
          case "failed":
          case "not_a_directory":
          case "is_a_directory":
          case "permission_denied":
          case "conflict":
          case "too_large":
          case "git_failed":
          case "busy":
            set("yes");
            break;
        }
      },
    )
    .finally(() => {
      probing = false;
    });
}

// Another Hako may be on the other end after the Mac has been away.
let wasUp = isUp();
relay.subscribe(() => {
  const up = isUp();
  if (up === wasUp) return;
  wasUp = up;
  if (!up) set("unknown");
  else if (listeners.size > 0) probe();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the Mac has said about adding folders. Asks, the first time a screen wants to know. */
export function useFolderSupport(): FolderSupport {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const current = useSyncExternalStore(subscribe, () => support);
  useEffect(() => {
    if (online) probe();
  }, [online, current]);
  return current;
}

/** Records what a real `folder.create` has just shown: that the Mac does not have the method. */
export function folderCreateUnsupported(): void {
  set("no");
}
