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
