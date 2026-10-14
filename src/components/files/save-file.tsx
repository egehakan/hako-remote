import { NEEDS_NEWER_HAKO } from "@/lib/errors";
import { formatSize } from "@/lib/files/format";
import { useConnection } from "@/lib/hooks";
import { isTouchDevice } from "@/lib/terminal/prefs";
import { useTransferSupport } from "@/lib/transfers/store";

/** What the action is called: a phone is "your phone", and anything else is not. */
export const SAVE_LABEL = isTouchDevice() ? "Save to phone" : "Save to this computer";

export type Saving = {
  /** False while saving cannot be started, and `reason` says why. */
  possible: boolean;
  reason: string | null;
};

/** Whether a file of `size` bytes can be fetched from the Mac right now. */
export function useSaving(size: number | null): Saving {
  const { link, agent } = useConnection();
  const support = useTransferSupport();
  if (support.state === "no") return { possible: false, reason: NEEDS_NEWER_HAKO };
  if (link !== "open" || agent?.online !== true) {
    return { possible: false, reason: "Your Mac is offline." };
  }
  if (size !== null && size > support.limits.maxBytes) {
    return {
      possible: false,
      reason: `Over the ${formatSize(support.limits.maxBytes)} limit for saving from here.`,
    };
  }
  return { possible: true, reason: null };
}
