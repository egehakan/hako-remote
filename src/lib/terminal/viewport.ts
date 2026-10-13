import { useSyncExternalStore } from "react";
import { isKeyboardOpen, isStandalone, isWholeAppVisible } from "@/lib/viewport";

// Several screens may follow the visible part of the page at once (a sheet over a file, say), so
// the listeners and the two properties are shared and last as long as anyone uses them.
const listeners = new Set<() => void>();
let keyboardOpen = false;
let frame = 0;

function update(): void {
  frame = 0;
  const viewport = window.visualViewport;
  const root = document.documentElement;
  // With nothing over the page the screen is as tall as the app, whose height is measured with
  // more care than the visual viewport reports it when the page has just appeared.
  root.style.setProperty(
    "--vv-height",
    isWholeAppVisible() ? "var(--app-height, 100%)" : `${viewport?.height ?? window.innerHeight}px`,
  );
  // A pinned screen is placed in the viewport, and one in the page (as in a home-screen app) in
  // the page, which the keyboard may have moved under the viewport.
  const top = isStandalone() ? viewport?.pageTop : viewport?.offsetTop;
  root.style.setProperty("--vv-top", `${top ?? 0}px`);
  // What is pinned whatever the app is opened as (a sheet) is always placed in the viewport.
  root.style.setProperty("--vv-pinned-top", `${viewport?.offsetTop ?? 0}px`);
  const open = isKeyboardOpen();
  if (open === keyboardOpen) return;
  keyboardOpen = open;
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (frame === 0) frame = requestAnimationFrame(update);
}

function subscribe(listener: () => void): () => void {
  const viewport = window.visualViewport;
  if (listeners.size === 0) {
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    cancelAnimationFrame(frame);
    frame = 0;
    keyboardOpen = false;
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.documentElement.style.removeProperty("--vv-height");
    document.documentElement.style.removeProperty("--vv-top");
    document.documentElement.style.removeProperty("--vv-pinned-top");
  };
}

/**
 * Follows the part of the page that is really visible. An on-screen keyboard slides over the page
 * without resizing it, so a screen with a text field sizes itself from `--vv-height` and
 * `--vv-top` instead, which keeps its keys directly above the keyboard. Returns whether a keyboard
 * is open.
 */
export function useVisibleViewport(): boolean {
  return useSyncExternalStore(subscribe, () => keyboardOpen);
}
