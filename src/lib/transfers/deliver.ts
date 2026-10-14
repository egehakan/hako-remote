// Handing a downloaded file to the device. An iPhone gets the share sheet, which is where "Save
// Image" and "Save to Files" are and the one way that works from a home-screen app; every other
// browser gets an ordinary download.

import { IOS } from "@/lib/platform";
import type { Downloaded } from "./engine";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/** The media type a share sheet or a download goes by, from the name's extension. */
export function mediaTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return TYPES[extension] ?? "application/octet-stream";
}

export function fileFrom(downloaded: Downloaded, name: string): File {
  return new File([downloaded.blob], name, {
    type: mediaTypeOf(name),
    lastModified: downloaded.mtime > 0 ? downloaded.mtime : Date.now(),
  });
}

/** True where a finished download is offered through the share sheet. */
export function sharesFiles(file: File): boolean {
  if (!IOS || typeof navigator.share !== "function") return false;
  try {
    return navigator.canShare?.({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export type Delivery =
  /** The device has it, or its share sheet was used. */
  | "saved"
  /** The share sheet may only open from a tap, and the tap that started this was too long ago. */
  | "needs-tap"
  /** The owner closed the share sheet without choosing. */
  | "dismissed";

function saveAs(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser reads the file from this address after the click has returned.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function deliver(file: File): Promise<Delivery> {
  if (!sharesFiles(file)) {
    saveAs(file);
    return "saved";
  }
  try {
    await navigator.share({ files: [file] });
    return "saved";
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "AbortError") return "dismissed";
    if (name === "NotAllowedError") return "needs-tap";
    saveAs(file);
    return "saved";
  }
}
