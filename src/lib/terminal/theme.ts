// The terminal's colours and font, as the Hako on the Mac is set up.

import type { TerminalTheme } from "@shared/protocol";
import type { ITheme } from "@xterm/xterm";
import { relay } from "../connection";

export type TerminalLook = {
  colors: ITheme;
  background: string;
  fontFamily: string;
  fontSize: number;
};

const FALLBACK_FONTS = '"Commit Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Used until the Mac answers, and for a Hako too old to know `theme.get`. */
const NEUTRAL: TerminalLook = {
  colors: {
    background: "#101010",
    foreground: "#d6d6d6",
    cursor: "#d6d6d6",
    cursorAccent: "#101010",
    selectionBackground: "#ffffff40",
  },
  background: "#101010",
  fontFamily: FALLBACK_FONTS,
  fontSize: 13,
};

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function color(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

function fromMac(theme: TerminalTheme): TerminalLook {
  const source = theme.terminal ?? {};
  const background = color(source.background, NEUTRAL.background)!;
  const colors: ITheme = {
    background,
    foreground: color(source.foreground, NEUTRAL.colors.foreground),
    cursor: color(source.cursor, NEUTRAL.colors.cursor),
    cursorAccent: background,
    selectionBackground: color(source.selection, NEUTRAL.colors.selectionBackground),
  };
  ANSI_NAMES.forEach((name, index) => {
    const value = color(source.ansi?.[index], undefined);
    if (value) colors[name] = value;
  });
  // The Mac's font is rarely installed on a phone, so the app's own monospace stands behind it.
  const family =
    typeof theme.font_family === "string" ? theme.font_family.replace(/["';{}\\]/g, "").trim() : "";
  const size = Number(theme.font_size);
  return {
    colors,
    background,
    fontFamily: family ? `"${family}", ${FALLBACK_FONTS}` : FALLBACK_FONTS,
    fontSize: Number.isFinite(size) && size >= 6 && size <= 40 ? size : NEUTRAL.fontSize,
  };
}

let look = NEUTRAL;
let loading = false;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    look = fromMac(await relay.request<TerminalTheme>("theme.get"));
    for (const listener of listeners) listener();
  } catch {
    // An older Hako (`not_supported`) or a lost connection: keep what is shown now.
  } finally {
    loading = false;
  }
}

relay.on("agent.status", (data) => {
  if ((data as { online?: boolean }).online && listeners.size > 0) void load();
});

export const terminalLook = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (look === NEUTRAL) void load();
    return () => listeners.delete(listener);
  },
  get: (): TerminalLook => look,
};
