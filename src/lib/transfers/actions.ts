// What the Files screens ask of the transfer queue.

import { refreshListing } from "@/lib/files/store";
import { deliver, fileFrom } from "./deliver";
import { FILES_GROUP, sourceOf, transfers } from "./store";

/**
 * Gives a finished download to the device. Called when the download ends and, where the share
 * sheet would not open by itself, again from the owner's tap.
 */
export async function handOver(id: number): Promise<void> {
  const item = transfers.get(id);
  if (!item?.downloaded) return;
  if ((await deliver(fileFrom(item.downloaded, item.name))) === "saved") {
    transfers.markDelivered(id);
  }
}

/** Downloads larger than this wait for the owner to see their size and say yes. */
export const LARGE_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Fetches a file from the Mac and hands it to this device. `size` is what the listing said. */
export function saveToDevice(path: string, name: string, size: number | null): void {
  transfers.addDownload({
    group: FILES_GROUP,
    path,
    name,
    size,
    askFirst: size !== null && size > LARGE_DOWNLOAD_BYTES,
    onDone: (transfer) => void handOver(transfer.id),
  });
}

/** Sends picked files into a directory on the Mac, exactly as they are. */
export function uploadFiles(directory: string, files: readonly File[]): void {
  for (const file of files) {
    transfers.addUpload({
      group: FILES_GROUP,
      source: sourceOf(file),
      destination: { kind: "dir", path: directory },
      name: file.name,
      onDone: () => refreshListing(directory),
    });
  }
}
