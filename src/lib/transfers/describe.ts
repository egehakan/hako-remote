// What a transfer says about itself in the owner's words.

import { formatSize } from "@/lib/files/format";
import type { Transfer } from "./queue";

export const NEEDS_NEWER_HAKO = "Update Hako on your Mac to use this.";

/** Why a transfer failed, and what to do about it. */
export function describeTransferFailure(transfer: Transfer, maxBytes: number): string {
  const { error, direction } = transfer;
  const message = error?.message ?? "";
  switch (error?.code) {
    case "too_large": {
      const limit = formatSize(maxBytes);
      // A file a few bytes over reads the same as the limit, and "52.4 MB is over 52.4 MB" helps nobody.
      return transfer.total !== null && formatSize(transfer.total) !== limit
        ? `${formatSize(transfer.total)} is over the ${limit} limit for one file.`
        : `Just over the ${limit} limit for one file.`;
    }
    case "not_supported":
      return "The Hako on your Mac can’t move files yet. Update it and try again.";
    case "permission_denied":
      return message ? `Your Mac refused: ${message}` : "Your Mac refused: permission denied.";
    case "changed":
      return "It changed on your Mac while it was being read.";
    case "agent_offline":
    case "disconnected":
      return "The connection to your Mac kept dropping.";
    case "timeout":
      return "Your Mac didn’t answer.";
    case "not_found":
      return direction === "download"
        ? "It isn’t there any more: moved, renamed or deleted on your Mac."
        : "Hako on your Mac lost track of this upload, as it does when it is restarted.";
    case "not_a_directory":
      return "This folder isn’t there any more on your Mac.";
    case "is_a_directory":
      return direction === "download"
        ? "That is a folder, which can’t be saved from here."
        : "A folder of that name is in the way.";
    case "conflict":
      return "A file of that name appeared on your Mac in the meantime.";
    default:
      return message ? `Your Mac said: ${message}` : "Your Mac couldn’t do that.";
  }
}

export function progressLabel(transfer: Transfer): string {
  if (transfer.total === null) return formatSize(transfer.moved);
  return `${formatSize(transfer.moved)} of ${formatSize(transfer.total)}`;
}

/** How far along a transfer is, from 0 to 1, or null when its size is not known yet. */
export function fraction(transfer: Transfer): number | null {
  if (transfer.total === null) return null;
  return transfer.total === 0 ? 1 : Math.min(1, transfer.moved / transfer.total);
}
