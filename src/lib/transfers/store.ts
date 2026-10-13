// The app's one queue of transfers, tied to the connection: what the Mac can do, when it can be
// asked again, and the hooks the screens read both through.

import type { FsTransferInfo } from "@shared/protocol";
import { TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from "@shared/transfers";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";
import type { TransferLimits, UploadSource } from "./engine";
import { type Transfer, TransferQueue } from "./queue";

/** The largest piece this client sends or asks for, whatever the Mac offers. */
const CHUNK_CEILING = 4 * 1024 * 1024;

export type TransferSupport = {
  /** Whether the Hako on the Mac has the transfer methods; "unknown" until it has answered. */
  state: "unknown" | "yes" | "no";
  limits: TransferLimits;
};

const DEFAULT_LIMITS: TransferLimits = {
  maxBytes: TRANSFER_MAX_BYTES,
  chunkBytes: TRANSFER_CHUNK_BYTES,
};

let support: TransferSupport = { state: "unknown", limits: DEFAULT_LIMITS };
let probing = false;
const supportListeners = new Set<() => void>();

function setSupport(next: TransferSupport): void {
  support = next;
  for (const listener of supportListeners) listener();
}

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

/** Asks the Mac once whether it moves files, and within which limits. */
function probe(): void {
  if (probing || support.state !== "unknown" || !isUp()) return;
  probing = true;
  relay
    .request<FsTransferInfo>("fs.transfer_info")
    .then(
      (info) => {
        const sane = (value: unknown) => typeof value === "number" && value >= 1;
        setSupport({
          state: "yes",
          limits: {
            maxBytes: sane(info?.max_bytes) ? info.max_bytes : TRANSFER_MAX_BYTES,
            chunkBytes: sane(info?.chunk_bytes)
              ? Math.min(Math.floor(info.chunk_bytes), CHUNK_CEILING)
              : TRANSFER_CHUNK_BYTES,
          },
        });
      },
      (error) => {
        // Any other failure says nothing about the app's age, and is asked again later.
        if (error instanceof RpcFailure && error.code === "not_supported") {
          setSupport({ state: "no", limits: DEFAULT_LIMITS });
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
  if (!up && support.state !== "unknown") setSupport({ state: "unknown", limits: DEFAULT_LIMITS });
  if (up && supportListeners.size > 0) probe();
});

function subscribeSupport(listener: () => void): () => void {
  supportListeners.add(listener);
  return () => supportListeners.delete(listener);
}

/** What the Mac has said about moving files. Asks, the first time a screen wants to know. */
export function useTransferSupport(): TransferSupport {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const current = useSyncExternalStore(subscribeSupport, () => support);
  useEffect(() => {
    if (online) probe();
  }, [online, current.state]);
  return current;
}

function waitForMac(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const done = (settle: () => void) => {
      stop();
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => done(() => reject(new Error("cancelled")));
    const stop = relay.subscribe(() => {
      if (isUp()) done(resolve);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (isUp()) done(resolve);
  });
}

export const transfers = new TransferQueue({
  rpc: (method, params, timeoutMs) => relay.request(method, params, timeoutMs),
  waitForMac,
  limits: () => support.limits,
});

/** The group of everything started from Files. A terminal's attachments have a group each. */
export const FILES_GROUP = "files";

export function attachGroup(sessionId: string): string {
  return `attach:${sessionId}`;
}

export function useTransfers(group: string): readonly Transfer[] {
  const all = useSyncExternalStore(transfers.subscribe, transfers.getSnapshot);
  return useMemo(() => all.filter((item) => item.group === group), [all, group]);
}

/** A picked file, or a picture drawn again, as something an upload can read piece by piece. */
export function sourceOf(blob: Blob): UploadSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

export function clearTransfers(): void {
  for (const item of transfers.getSnapshot()) transfers.drop(item.group);
  setSupport({ state: "unknown", limits: DEFAULT_LIMITS });
}
