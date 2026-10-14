// The previews the Mac runs, kept current from `previews.changed`, and what can be done to them.

import type { Preview, PreviewListResult } from "@shared/previews";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { relay, RpcFailure } from "@/lib/connection";

export type PreviewsSnapshot = {
  previews: Preview[] | null;
  /** "no" when the Hako on the Mac is too old to have previews. */
  support: "unknown" | "yes" | "no";
  error: string | null;
  loading: boolean;
};

const EMPTY: PreviewsSnapshot = { previews: null, support: "unknown", error: null, loading: false };

let snapshot: PreviewsSnapshot = EMPTY;
let loading: Promise<void> | null = null;
let again = false;
let changeTimer: number | undefined;
const listeners = new Set<() => void>();

function set(change: Partial<PreviewsSnapshot>): void {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

/** Reads the list again; a call while one is under way asks for one more after it. */
export function loadPreviews(): Promise<void> {
  if (!isUp()) return Promise.resolve();
  if (loading) {
    again = true;
    return loading;
  }
  set({ loading: true });
  loading = relay
    .request<PreviewListResult>("preview.list", {})
    .then(
      (result) => set({ previews: result.previews, support: "yes", error: null, loading: false }),
      (failure: unknown) => {
        if (failure instanceof RpcFailure && failure.code === "not_supported") {
          set({ previews: [], support: "no", error: null, loading: false });
        } else {
          set({
            error: failure instanceof RpcFailure ? failure.message : "Couldn’t read the previews",
            loading: false,
          });
        }
      },
    )
    .finally(() => {
      loading = null;
      if (again) {
        again = false;
        void loadPreviews();
      }
    });
  return loading;
}

let wasUp = false;
relay.subscribe(() => {
  const up = isUp();
  if (up === wasUp) return;
  wasUp = up;
  // Another Hako may answer once the Mac is back, so what this one said is forgotten.
  if (up) void loadPreviews();
  else set({ ...EMPTY, previews: snapshot.previews });
});

relay.on("previews.changed", () => {
  window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => void loadPreviews(), 150);
});

export const previewsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): PreviewsSnapshot => snapshot,
  clear(): void {
    snapshot = EMPTY;
    for (const listener of listeners) listener();
  },
};

export function usePreviews(): PreviewsSnapshot {
  return useSyncExternalStore(previewsStore.subscribe, previewsStore.getSnapshot);
}

export function stopPreview(id: string): Promise<void> {
  return relay.request("preview.stop", { id }).then(() => loadPreviews());
}

export function restartPreview(id: string): Promise<void> {
  // A restart waits for the old server to stop, which can take a moment.
  return relay.request("preview.restart", { id }, 60_000).then(() => loadPreviews());
}

export function removePreview(id: string): Promise<void> {
  return relay.request("preview.remove", { id }, 60_000).then(() => loadPreviews());
}

/** A one-time address that lets this browser into a preview, at `path`. */
export async function previewTicket(id: string, path: string): Promise<string> {
  const result = await api.previewTicket(id, path);
  if (!result.ok) {
    throw new Error(
      result.error.kind === "network"
        ? "Couldn’t reach the relay. Check the connection and try again."
        : "The relay wouldn’t open this preview. Try again in a moment.",
    );
  }
  return result.value.url;
}
