// Whether the Hako on the Mac has the Mac browser, which browser each preview is shown in, and the
// device a viewport choice makes the Mac's browser pretend to be.

import type { BrowserViewport } from "@shared/browser";
import { useEffect, useSyncExternalStore } from "react";
import { relay, RpcFailure } from "@/lib/connection";
import { useConnection } from "@/lib/hooks";
import { fitSize, type ViewChoice, viewportSize } from "@/lib/previews/viewports";
import { isTouchDevice } from "@/lib/terminal/prefs";

export type MacBrowserSupport = "unknown" | "yes" | "no";

let support: MacBrowserSupport = "unknown";
let probing = false;
const listeners = new Set<() => void>();

function setSupport(next: MacBrowserSupport): void {
  if (next === support) return;
  support = next;
  for (const listener of listeners) listener();
}

const isUp = () => {
  const { link, agent } = relay.getSnapshot();
  return link === "open" && agent?.online === true;
};

/** `browser.open` with an address that is not one: `bad_request` from an app that has it. */
function probe(): void {
  if (probing || support !== "unknown" || !isUp()) return;
  probing = true;
  relay
    .request("browser.open", {
      url: "?",
      viewport: { width: 400, height: 400, scale: 1, mobile: false, touch: false },
    })
    .then(
      // An answer at all is a Mac browser, if one that took "?" as an address: close what it opened.
      (result) => {
        const bid = (result as { bid?: unknown } | null)?.bid;
        if (typeof bid === "number") void relay.request("browser.close", { bid }).catch(() => {});
        setSupport("yes");
      },
      (error: unknown) => {
        if (!(error instanceof RpcFailure)) return;
        if (error.code === "not_supported") setSupport("no");
        else if (error.code === "bad_request") setSupport("yes");
      },
    )
    .finally(() => {
      probing = false;
    });
}

let wasUp = isUp();
relay.subscribe(() => {
  const up = isUp();
  if (up === wasUp) return;
  wasUp = up;
  // Another Hako may answer once the Mac is back.
  if (!up) setSupport("unknown");
  else if (listeners.size > 0) probe();
});

export function useMacBrowserSupport(): MacBrowserSupport {
  const { link, agent } = useConnection();
  const online = link === "open" && agent?.online === true;
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => support,
  );
  useEffect(() => {
    if (online) probe();
  }, [online, current]);
  return current;
}

/** Records what a session learned the hard way, so the next screen does not ask again. */
export function noteMacBrowserSupport(value: "yes" | "no"): void {
  setSupport(value);
}

// The browser a preview is shown in

export type ViewerMode = "mac" | "phone";

const modeKey = (previewId: string) => `hako.preview.mode.${previewId}`;

export function readMode(previewId: string): ViewerMode {
  try {
    return localStorage.getItem(modeKey(previewId)) === "phone" ? "phone" : "mac";
  } catch {
    return "mac";
  }
}

export function writeMode(previewId: string, mode: ViewerMode): void {
  try {
    localStorage.setItem(modeKey(previewId), mode);
  } catch {
    // Private browsing: the choice lasts as long as the page.
  }
}

// The device

/** Pixel ratios of the preset devices; computers get 1 to keep their larger pictures light. */
const SCALES: Record<string, number> = {
  "iphone-se": 2,
  "iphone-15": 3,
  "iphone-16-pro-max": 3,
  "pixel-8": 2.625,
  "ipad-mini": 2,
  "ipad-air": 2,
  laptop: 1,
  desktop: 1,
  "desktop-hd": 1,
};

const TOUCH_PRESETS = new Set([
  "iphone-se",
  "iphone-15",
  "iphone-16-pro-max",
  "pixel-8",
  "ipad-mini",
  "ipad-air",
]);

/** Below this width a custom size is taken for a phone or a tablet. */
const CUSTOM_TOUCH_BELOW = 800;

/**
 * The device the Mac's browser pretends to be for a choice. Fit is this screen: the space there is
 * on it (turned a quarter when rotated), its own pixel ratio, and touch when it is a touch device.
 * No user agent is given: the Mac's Chrome keeps its own, which Google's sign-in expects.
 */
export function deviceFor(
  choice: ViewChoice,
  space: { width: number; height: number },
): BrowserViewport {
  const size = viewportSize(choice);
  if (size === null) {
    const touch = isTouchDevice();
    return {
      ...fitSize(choice, space),
      scale: Math.min(3, Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100)),
      mobile: touch,
      touch,
    };
  }
  const touch =
    choice.viewport === "custom"
      ? Math.min(size.width, size.height) < CUSTOM_TOUCH_BELOW
      : TOUCH_PRESETS.has(choice.viewport);
  const scale = choice.viewport === "custom" ? (touch ? 2 : 1) : (SCALES[choice.viewport] ?? 1);
  return { width: size.width, height: size.height, scale, mobile: touch, touch };
}
