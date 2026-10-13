// "Fit to phone" only ever makes the Mac's terminal smaller.

export type FitSize = { cols: number; rows: number };

/**
 * The size to ask the Mac for: what this screen holds, but in neither direction more than the
 * terminal has on the Mac by itself. A pane cut to a size larger than its own window shows loses
 * its last rows there, where a full-screen program draws its prompt.
 */
export function capFit(wanted: FitSize, mac: FitSize | null): FitSize {
  if (mac === null) return wanted;
  return { cols: Math.min(wanted.cols, mac.cols), rows: Math.min(wanted.rows, mac.rows) };
}
