// Whether the Hako on the Mac has a method, found out by asking it something it must refuse. Asked
// once each time the Mac comes online, the first time a screen wants to know.

import { useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";

/** "unknown" until the Mac has answered. */
export type Support = "unknown" | "yes" | "no";

export type Probe = {
  use: () => Support;
  /** Records what a real request has just shown: that the Mac does not have the method. */
  unsupported: () => void;
};

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

/** `params` must be something an app that has `method` refuses without doing anything. */
export function createProbe(method: string, params: object): Probe {
  let support: Support = "unknown";
  let probing = false;
  const listeners = new Set<() => void>();

  const set = (next: Support) => {
    if (support === next) return;
    support = next;
    for (const listener of listeners) listener();
  };

  const probe = () => {
    if (probing || support !== "unknown" || !isUp()) return;
    probing = true;
    relay
      .request(method, params)
      .then(
        () => set("yes"),
        (error) => {
          if (!(error instanceof RpcFailure)) return;
          // The Mac did not get to answer, which says nothing about its age: asked again later.
          if (error.code === "agent_offline" || error.code === "timeout") return;
          if (error.code === "disconnected") return;
          set(error.code === "not_supported" ? "no" : "yes");
        },
      )
      .finally(() => {
        probing = false;
      });
  };

  // Another Hako may be on the other end after the Mac has been away.
  let wasUp = isUp();
  relay.subscribe(() => {
    const up = isUp();
    if (up === wasUp) return;
    wasUp = up;
    if (!up) set("unknown");
    else if (listeners.size > 0) probe();
  });

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    use() {
      const { link, agent } = useConnection();
      const online = link === "open" && agent?.online === true;
      const current = useSyncExternalStore(subscribe, () => support);
      useEffect(() => {
        if (online) probe();
      }, [online, current]);
      return current;
    },
    unsupported: () => set("no"),
  };
}

/** Renaming tabs and folders (round 2). "?" names no tab, so nothing is renamed. */
export const renameSupport = createProbe("tab.rename", { tab_id: "?", title: "?" });

/** Merging a branch (round 3). "?" is not a repository, so nothing is merged. */
export const mergeSupport = createProbe("git.merge", { repo: "?", branch: "?", kind: "local" });

export const useRenameSupport = (): Support => renameSupport.use();
export const useMergeSupport = (): Support => mergeSupport.use();
