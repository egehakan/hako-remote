// How tall the app is. The root is laid out by the stylesheet; this measures the screen as well,
// because a phone does not always report its size correctly when the page first appears, and a
// document that never scrolls gets no second chance to be laid out.

import { fullHeight } from "./full-height.ts";

/** A keyboard is taken to be open when it hides at least this much of the page, in CSS pixels. */
const KEYBOARD_MIN_HEIGHT = 120;

/** True while an on-screen keyboard covers part of the page. */
export function isKeyboardOpen(): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  // Pinch-zooming the page also shrinks the visible part; only an unzoomed gap is a keyboard.
  return window.innerHeight - viewport.height * viewport.scale > KEYBOARD_MIN_HEIGHT;
}

function isZoomed(): boolean {
  return Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01;
}

/** True when the whole app is in view: no keyboard over it, not zoomed into, not moved. */
export function isWholeAppVisible(): boolean {
  return !isKeyboardOpen() && !isZoomed() && (window.visualViewport?.offsetTop ?? 0) < 1;
}

/**
 * True for the app opened from a home screen, with no browser around it. The stylesheet lays that
 * app out differently, and finds out from the `data-display` attribute this is read from.
 */
export function isStandalone(): boolean {
  return document.documentElement.dataset.display === "standalone";
}

/** How long after the page appears its size is measured again, in milliseconds. */
const SETTLE_DELAYS_MS = [120, 500, 1500];

/**
 * Keeps `--app-height` on the root element equal to the height the app should fill, from the first
 * frame on and whenever the screen changes, and marks a home-screen app as one. Call once, before
 * the app is drawn.
 */
export function watchAppHeight(): void {
  const root = document.documentElement;
  const homeScreenApp = (navigator as { standalone?: boolean }).standalone === true;
  const standalone = homeScreenApp || window.matchMedia("(display-mode: standalone)").matches;
  if (standalone) root.dataset.display = "standalone";
  let applied = 0;
  let frame = 0;
  let nudged = false;

  const layoutHeight = () => Math.max(window.innerHeight, root.clientHeight);

  const apply = () => {
    frame = 0;
    const height = fullHeight({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientHeight: root.clientHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      homeScreenApp,
    });
    if (height > 0 && height !== applied) {
      applied = height;
      root.style.setProperty("--app-height", `${height}px`);
    }
    // A home-screen app whose viewport started short is taller than that viewport, so its page can
    // be moved a little. That is left alone: a scroll is what makes the phone measure again.
    const short = standalone && layoutHeight() < applied;
    // A keyboard moves the page up to show the field being typed in. Once it has gone the page
    // must be back at the top, and a page that cannot scroll never gets there by itself.
    if (!short && isWholeAppVisible() && (window.scrollY !== 0 || window.scrollX !== 0)) {
      window.scrollTo(0, 0);
    }
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(apply);
  };
  /**
   * Moves a short-started page by one pixel and back, once: the phone corrects its viewport on a
   * scroll, and this spares the owner making one.
   */
  const nudge = () => {
    if (nudged || !standalone || layoutHeight() >= applied || !isWholeAppVisible()) return;
    nudged = true;
    window.scrollTo(0, 1);
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      schedule();
    });
  };
  // A page that has just appeared may still report the size it had before it settled, and nothing
  // announces the correction.
  const settle = () => {
    schedule();
    for (const delay of SETTLE_DELAYS_MS) window.setTimeout(schedule, delay);
    window.setTimeout(nudge, SETTLE_DELAYS_MS[0] + 60);
  };

  apply();
  settle();
  window.addEventListener("pageshow", settle);
  window.addEventListener("orientationchange", settle);
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") settle();
  });
}
