// The sizes a preview can be shown at, how one is scaled into the space there is, and the choice
// remembered for each preview on this device.

export type ViewportPreset = {
  id: string;
  name: string;
  width: number;
  height: number;
  group: "Phones" | "Tablets" | "Computers";
};

export const VIEWPORTS: readonly ViewportPreset[] = [
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, group: "Phones" },
  { id: "iphone-15", name: "iPhone 15/16", width: 393, height: 852, group: "Phones" },
  { id: "iphone-16-pro-max", name: "iPhone 16 Pro Max", width: 440, height: 956, group: "Phones" },
  { id: "pixel-8", name: "Pixel 8", width: 412, height: 915, group: "Phones" },
  { id: "ipad-mini", name: "iPad mini", width: 744, height: 1133, group: "Tablets" },
  { id: "ipad-air", name: "iPad Air", width: 820, height: 1180, group: "Tablets" },
  { id: "laptop", name: "Laptop", width: 1280, height: 800, group: "Computers" },
  { id: "desktop", name: "Desktop", width: 1440, height: 900, group: "Computers" },
  { id: "desktop-hd", name: "Desktop HD", width: 1920, height: 1080, group: "Computers" },
];

export const CUSTOM_MIN = 200;
export const CUSTOM_MAX = 3840;

/** `fit` fills the space there is; anything else is a fixed CSS size. */
export type ViewChoice = {
  viewport: "fit" | "custom" | string;
  custom: { width: number; height: number };
  rotated: boolean;
  /** Null to scale the page down to fit; otherwise the scale the owner picked. */
  zoom: number | null;
};

export const DEFAULT_CHOICE: ViewChoice = {
  viewport: "fit",
  custom: { width: 1024, height: 768 },
  rotated: false,
  zoom: null,
};

export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

/** The CSS size a choice renders the page at, or null for `fit`. */
export function viewportSize(choice: ViewChoice): { width: number; height: number } | null {
  let size: { width: number; height: number };
  if (choice.viewport === "fit") return null;
  if (choice.viewport === "custom") size = choice.custom;
  else {
    const preset = VIEWPORTS.find((item) => item.id === choice.viewport);
    if (!preset) return null;
    size = { width: preset.width, height: preset.height };
  }
  return choice.rotated ? { width: size.height, height: size.width } : size;
}

/** The scale at which a page of `size` fits into `space`, never above 1. */
export function fitScale(
  size: { width: number; height: number },
  space: { width: number; height: number },
): number {
  if (space.width <= 0 || space.height <= 0) return 1;
  return Math.min(1, space.width / size.width, space.height / size.height);
}

/** The zoom steps around the fitting scale: the fitting one, then each fixed step above it. */
export function zoomLevels(fit: number): number[] {
  return [fit, ...ZOOM_STEPS.filter((step) => step > fit + 0.01)];
}

export function viewportLabel(choice: ViewChoice): string {
  if (choice.viewport === "fit") return "Fit";
  if (choice.viewport === "custom") return "Custom";
  return VIEWPORTS.find((item) => item.id === choice.viewport)?.name ?? "Fit";
}

function clampDimension(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, number));
}

const key = (previewId: string) => `hako.preview.view.${previewId}`;

export function readChoice(previewId: string): ViewChoice {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(previewId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return DEFAULT_CHOICE;
    const value = stored as Partial<ViewChoice>;
    const known =
      value.viewport === "fit" ||
      value.viewport === "custom" ||
      VIEWPORTS.some((item) => item.id === value.viewport);
    return {
      viewport: known ? (value.viewport as string) : "fit",
      custom: {
        width: clampDimension(value.custom?.width, DEFAULT_CHOICE.custom.width),
        height: clampDimension(value.custom?.height, DEFAULT_CHOICE.custom.height),
      },
      rotated: value.rotated === true,
      zoom:
        typeof value.zoom === "number" && value.zoom >= 0.1 && value.zoom <= 4 ? value.zoom : null,
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function writeChoice(previewId: string, choice: ViewChoice): void {
  try {
    localStorage.setItem(key(previewId), JSON.stringify(choice));
  } catch {
    // Private browsing: the choice lasts as long as the page.
  }
}

export { clampDimension };
