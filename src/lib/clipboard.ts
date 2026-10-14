// Text put on the device's clipboard from a tap, and what the page says about it afterwards.

/** The last text copied, or offered to copy by hand when the browser would not take it. */
export type CopyNotice = { id: number; text: string; copied: boolean };

let notice: CopyNotice | null = null;
let count = 0;
const listeners = new Set<() => void>();

function show(next: CopyNotice | null): void {
  notice = next;
  for (const listener of listeners) listener();
}

export const copyNotices = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): CopyNotice | null => notice,
  dismiss(id: number): void {
    if (notice?.id === id) show(null);
  },
};

/**
 * Puts `text` on the clipboard. Call it straight from the tap's handler, before anything is
 * awaited: iOS lets a page write to the clipboard only while it handles the tap.
 */
export function copyText(text: string): void {
  count += 1;
  const id = count;
  let writing: Promise<void>;
  try {
    writing = navigator.clipboard.writeText(text);
  } catch (error) {
    // No Clipboard API at all, as on a page that is not served over HTTPS.
    writing = Promise.reject(error);
  }
  writing.then(
    () => show({ id, text, copied: true }),
    () => show({ id, text, copied: false }),
  );
}

/**
 * Puts text that is still on its way (from the Mac) on the clipboard. Call it straight from the
 * tap's handler: the write starts in the tap with a promise of the text, which is how iOS lets a page
 * copy something it has to fetch first. Rejects with the text's own failure; a clipboard that will
 * not take it shows the text to copy by hand.
 */
export async function copyTextLater(text: Promise<string>): Promise<void> {
  count += 1;
  const id = count;
  let writing: Promise<void>;
  try {
    if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      writing = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      writing = text.then((value) => navigator.clipboard.writeText(value));
    }
  } catch (error) {
    writing = Promise.reject(error);
  }
  // A text that never came fails the write too; that failure is the text's to report.
  writing.catch(() => {});
  const value = await text;
  try {
    await writing;
    show({ id, text: value, copied: true });
  } catch {
    show({ id, text: value, copied: false });
  }
}
