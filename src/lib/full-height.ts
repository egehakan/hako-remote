// The one decision in src/lib/viewport.ts that can be got wrong, kept apart from the page so that it
// can be tested.

export type ViewportReading = {
  innerWidth: number;
  innerHeight: number;
  /** The height of the root element's containing block. */
  clientHeight: number;
  screenWidth: number;
  screenHeight: number;
  /** True for the app opened from the home screen of an iPhone or iPad, where no browser bar exists. */
  homeScreenApp: boolean;
};

/**
 * The most a home-screen app can be short of its screen and still be taken to fill it: the status
 * bar and the home indicator together, with room to spare. A window that is shorter than that is a
 * window of its own size (an iPad showing two apps), not a wrong measurement.
 */
const MAX_SHORTFALL = 140;

/**
 * The height the app should fill, in CSS pixels. Opened from the home screen an iPhone can start
 * with a viewport that is short by the height of the status bar, although the page is drawn under
 * that bar; there the screen itself is the better witness.
 */
export function fullHeight(reading: ViewportReading): number {
  const layout = Math.max(reading.innerHeight, reading.clientHeight);
  if (!reading.homeScreenApp) return layout;
  // An iPhone reports its screen as it is held upright, whichever way it is turned.
  const shortSide = Math.min(reading.screenWidth, reading.screenHeight);
  const longSide = Math.max(reading.screenWidth, reading.screenHeight);
  const upright = reading.innerHeight >= reading.innerWidth;
  const width = upright ? shortSide : longSide;
  const height = upright ? longSide : shortSide;
  const fillsTheScreen = Math.abs(reading.innerWidth - width) < 1;
  const missing = height - layout;
  return fillsTheScreen && missing > 0 && missing <= MAX_SHORTFALL ? height : layout;
}
