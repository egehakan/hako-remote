import { useEffect, useState } from "react";

/** A keyboard is taken to be open when it hides at least this much of the page, in CSS pixels. */
const KEYBOARD_MIN_HEIGHT = 120;

/**
 * Follows the part of the page that is really visible. An on-screen keyboard slides over the page
 * without resizing it, so the terminal screen sizes itself from `--vv-height` and `--vv-top`
 * instead, which keeps its key bar directly above the keyboard. Returns whether a keyboard is open.
 */
export function useVisibleViewport(): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;

    const update = () => {
      frame = 0;
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--vv-height", `${height}px`);
      root.style.setProperty("--vv-top", `${viewport?.offsetTop ?? 0}px`);
      // Pinch-zooming the page also shrinks the visible part; only an unzoomed gap is a keyboard.
      const hidden = window.innerHeight - height * (viewport?.scale ?? 1);
      setKeyboardOpen(hidden > KEYBOARD_MIN_HEIGHT);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-top");
    };
  }, []);

  return keyboardOpen;
}
