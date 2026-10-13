import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type VirtualListProps<T> = {
  items: readonly T[];
  /** Every row has this height, in CSS pixels, which is what makes the arithmetic exact. */
  rowHeight: number;
  itemKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  /** Names the list whose scroll position is kept, so coming back to it lands on the same row. */
  scrollKey: string;
  /** When this changes the list is a different selection of rows, and starts from its top. */
  resetKey: string;
  label: string;
  className?: string;
};

const OVERSCAN = 8;
const positions = new Map<string, number>();

/** A list that only builds the rows on screen, so five thousand entries scroll like fifty. */
export function VirtualList<T>({
  items,
  rowHeight,
  itemKey,
  renderRow,
  scrollKey,
  resetKey,
  label,
  className,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const shownFor = useRef(resetKey);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const count = items.length;

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const start = Math.max(0, Math.floor(element.scrollTop / rowHeight) - OVERSCAN);
    const end = Math.min(
      count,
      Math.ceil((element.scrollTop + element.clientHeight) / rowHeight) + OVERSCAN,
    );
    setRange((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  }, [count, rowHeight]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = positions.get(scrollKey) ?? 0;
    return () => {
      positions.set(scrollKey, element.scrollTop);
    };
  }, [scrollKey]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || shownFor.current === resetKey) return;
    shownFor.current = resetKey;
    element.scrollTop = 0;
  }, [resetKey]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const rows: ReactNode[] = [];
  for (let index = range.start; index < Math.min(range.end, count); index++) {
    const item = items[index];
    rows.push(
      <li
        key={itemKey(item)}
        className="absolute inset-x-0"
        style={{ top: index * rowHeight, height: rowHeight }}
      >
        {renderRow(item)}
      </li>,
    );
  }

  return (
    <div
      ref={scroller}
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}
      onScroll={measure}
    >
      <ul aria-label={label} className="relative" style={{ height: count * rowHeight }}>
        {rows}
      </ul>
    </div>
  );
}
