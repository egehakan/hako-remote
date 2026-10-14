// Where the picture of the Mac's page sits on the stage, and which CSS pixel of the page a point on
// the stage stands for. Pure, so the arithmetic that every tap goes through can be tested.

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/**
 * The picture's place: its top-left corner on the stage, and how many stage pixels one CSS pixel of
 * the page takes.
 */
export type Placement = { left: number; top: number; scale: number };

/** The scale at which a page of `size` fits into `space`, never above 1. */
export function fitScale(size: Size, space: Size): number {
  if (space.width <= 0 || space.height <= 0 || size.width <= 0 || size.height <= 0) return 1;
  return Math.min(1, space.width / size.width, space.height / size.height);
}

/**
 * Keeps a pan inside what can be panned: along an axis where the picture is smaller than the stage
 * there is nothing to pan, and where it is larger its edges never come inside the stage's.
 * `pan` is how far the picture is moved from its centred place, in stage pixels.
 */
export function clampPan(stage: Size, page: Size, scale: number, pan: Point): Point {
  const room = (stageLength: number, pageLength: number) =>
    Math.max(0, (pageLength * scale - stageLength) / 2);
  const x = room(stage.width, page.width);
  const y = room(stage.height, page.height);
  // `+ 0` turns the -0 that clamping to an empty range gives into 0.
  return { x: Math.min(x, Math.max(-x, pan.x)) + 0, y: Math.min(y, Math.max(-y, pan.y)) + 0 };
}

/** The picture centred on the stage at `scale`, moved by `pan` (kept within bounds). */
export function place(stage: Size, page: Size, scale: number, pan: Point): Placement {
  const kept = clampPan(stage, page, scale, pan);
  return {
    left: (stage.width - page.width * scale) / 2 + kept.x,
    top: (stage.height - page.height * scale) / 2 + kept.y,
    scale,
  };
}

/**
 * The CSS pixel of the page under a point of the stage, or null when the point is off the picture.
 * `page` is the size the picture on screen was drawn at, which during a rotation can still be the
 * old one: a tap lands where it was aimed on what the owner saw.
 */
export function toPage(point: Point, placement: Placement, page: Size): Point | null {
  const x = (point.x - placement.left) / placement.scale;
  const y = (point.y - placement.top) / placement.scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.min(page.width - 0.01, x), y: Math.min(page.height - 0.01, y) };
}

/** The same as `toPage`, but a point off the picture is moved onto its nearest edge. */
export function toPageClamped(point: Point, placement: Placement, page: Size): Point {
  const x = (point.x - placement.left) / placement.scale;
  const y = (point.y - placement.top) / placement.scale;
  return {
    x: Math.min(page.width - 0.01, Math.max(0, x)),
    y: Math.min(page.height - 0.01, Math.max(0, y)),
  };
}

/** Where a CSS pixel of the page is on the stage. */
export function toStage(point: Point, placement: Placement): Point {
  return {
    x: placement.left + point.x * placement.scale,
    y: placement.top + point.y * placement.scale,
  };
}

/**
 * The pan that keeps the page point under `focus` (a stage point) where it is while the scale
 * changes from `from` to `to`: how a pinch zooms around the fingers.
 */
export function zoomAround(
  stage: Size,
  page: Size,
  from: { scale: number; pan: Point },
  to: number,
  focus: Point,
): Point {
  const before = place(stage, page, from.scale, from.pan);
  const anchor = {
    x: (focus.x - before.left) / before.scale,
    y: (focus.y - before.top) / before.scale,
  };
  // The centred place at the new scale, then moved so the anchor is back under the focus.
  const centred = place(stage, page, to, { x: 0, y: 0 });
  const pan = {
    x: focus.x - anchor.x * to - centred.left,
    y: focus.y - anchor.y * to - centred.top,
  };
  return clampPan(stage, page, to, pan);
}
