import { useEffect, useState } from "react";
import { isKeyboardOpen, isStandalone, isWholeAppVisible } from "@/lib/viewport";

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
      // With nothing over the page the screen is as tall as the app, whose height is measured with
      // more care than the visual viewport reports it when the page has just appeared.
      root.style.setProperty(
        "--vv-height",
        isWholeAppVisible()
          ? "var(--app-height, 100%)"
          : `${viewport?.height ?? window.innerHeight}px`,
      );
      // A pinned screen is placed in the viewport, and one in the page (as in a home-screen app)
      // in the page, which the keyboard may have moved under the viewport.
      const top = isStandalone() ? viewport?.pageTop : viewport?.offsetTop;
      root.style.setProperty("--vv-top", `${top ?? 0}px`);
      setKeyboardOpen(isKeyboardOpen());
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
