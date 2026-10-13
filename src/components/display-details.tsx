import { useState } from "react";
import { Button } from "@/components/ui/button";

const number = (value: number | undefined) =>
  value === undefined ? "?" : String(Math.round(value * 100) / 100);

/** The four safe-area insets, read from an element that is padded by them. */
function safeAreaInsets(): string {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = `top ${style.paddingTop}, right ${style.paddingRight}, bottom ${style.paddingBottom}, left ${style.paddingLeft}`;
  probe.remove();
  return insets;
}

function measure(): string {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const app = document.getElementById("root")?.getBoundingClientRect();
  const body = document.body.getBoundingClientRect();
  const page = root.getBoundingClientRect();
  const lines: [string, string][] = [
    ["navigator.standalone", String((navigator as { standalone?: boolean }).standalone)],
    ["display-mode: standalone", String(window.matchMedia("(display-mode: standalone)").matches)],
    ["data-display", root.dataset.display ?? "(not set)"],
    ["inner", `${window.innerWidth} x ${window.innerHeight}`],
    ["documentElement client", `${root.clientWidth} x ${root.clientHeight}`],
    ["screen", `${window.screen.width} x ${window.screen.height}`],
    [
      "visualViewport",
      viewport
        ? `${number(viewport.width)} x ${number(viewport.height)}, offsetTop ${number(viewport.offsetTop)}, pageTop ${number(viewport.pageTop)}, scale ${number(viewport.scale)}`
        : "none",
    ],
    ["scroll", `${number(window.scrollX)}, ${number(window.scrollY)}`],
    ["safe area", safeAreaInsets()],
    ["--app-height", root.style.getPropertyValue("--app-height") || "(not set)"],
    ["--vv-height", root.style.getPropertyValue("--vv-height") || "(not set)"],
    ["--vv-top", root.style.getPropertyValue("--vv-top") || "(not set)"],
    ["#root rect", app ? `top ${number(app.top)}, height ${number(app.height)}` : "none"],
    ["body rect", `top ${number(body.top)}, height ${number(body.height)}`],
    ["html rect", `top ${number(page.top)}, height ${number(page.height)}`],
    ["devicePixelRatio", number(window.devicePixelRatio)],
    ["measured", new Date().toISOString()],
    ["user agent", navigator.userAgent],
  ];
  return lines.map(([name, value]) => `${name}: ${value}`).join("\n");
}

/**
 * What this device says about its screen, for when the layout looks wrong on it: a screenshot of
 * these lines says what a description cannot.
 */
export function DisplayDetails() {
  const [text, setText] = useState<string | null>(null);
  return (
    <details
      className="text-sm"
      onToggle={(event) => setText(event.currentTarget.open ? measure() : null)}
    >
      <summary className="cursor-pointer rounded-sm py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70">
        Display details
      </summary>
      <p className="mt-1 text-[0.8125rem] leading-5 text-muted-foreground">
        What this device reports about its screen. If the app is cut off or leaves a gap, a
        screenshot of these lines shows why.
      </p>
      {text !== null ? (
        <pre
          className="mt-3 rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap select-text"
          translate="no"
        >
          {text}
        </pre>
      ) : null}
      <Button variant="secondary" className="mt-3 h-10 px-3" onClick={() => setText(measure())}>
        Measure again
      </Button>
    </details>
  );
}
