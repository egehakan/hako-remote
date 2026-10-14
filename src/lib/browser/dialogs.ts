// The page dialog a Mac browser session shows, and when it has gone on the Mac without a reply from
// this phone (docs/protocol.md, "Mac browser", Dialogs).

import type { BrowserDialog, BrowserDialogClosed, BrowserState } from "../../../shared/browser.ts";

/**
 * How long after a dialog opens its tab's address may still change without closing it: the state
 * of a page that opens a dialog as it loads can arrive just after the dialog.
 */
export const DIALOG_SETTLE_MS = 1000;

export type OpenDialog = Omit<BrowserDialog, "tab"> & {
  /** The tab that shows it, or null when neither the app nor the session's state names one. */
  tab: string | null;
  /** That tab's address when the dialog opened, as far as the phone knows it. */
  url: string | null;
  openedAt: number;
};

function urlOf(state: BrowserState, tab: string): string | null {
  if (state.tab === tab) return state.url;
  return state.tabs.find((item) => item.id === tab)?.url ?? null;
}

export function openDialog(
  event: BrowserDialog,
  state: BrowserState | null,
  now: number,
): OpenDialog {
  const tab = event.tab ?? state?.tab ?? null;
  return { ...event, tab, url: tab !== null && state ? urlOf(state, tab) : null, openedAt: now };
}

/**
 * The dialog after a `browser.state`: gone once its tab is at another address or closed, which
 * dismisses a dialog in a browser.
 */
export function dialogAfterState(
  dialog: OpenDialog | null,
  state: BrowserState,
  now: number,
): OpenDialog | null {
  if (dialog === null || dialog.tab === null) return dialog;
  const url = urlOf(state, dialog.tab);
  const settling = now - dialog.openedAt < DIALOG_SETTLE_MS;
  if (url === null) return settling ? dialog : null;
  if (url === dialog.url) return dialog;
  return settling || dialog.url === null ? { ...dialog, url } : null;
}

/** The dialog after `browser.dialog_closed`. */
export function dialogAfterClosed(
  dialog: OpenDialog | null,
  closed: BrowserDialogClosed,
): OpenDialog | null {
  return dialog !== null && (dialog.tab === null || dialog.tab === closed.tab) ? null : dialog;
}
