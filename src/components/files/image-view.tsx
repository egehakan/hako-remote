import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type View = { scale: number; x: number; y: number };

const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 8;
const DOUBLE_TAP_MS = 300;

type ImageViewProps = {
  src: string;
  name: string;
  onSize: (width: number, height: number) => void;
};

/** A picture fitted to the screen, which two fingers (or a wheel, or the buttons) zoom into. */
export function ImageView({ src, name, onSize }: ImageViewProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const latest = useRef(view);
  latest.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; distance: number } | null>(null);
  const lastTap = useRef(0);

  /** A position on screen, measured from the middle of the frame. */
  const fromCentre = (x: number, y: number) => {
    const box = frame.current!.getBoundingClientRect();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  };

  const settle = (next: View): View => {
    const box = frame.current?.getBoundingClientRect();
    const scale = Math.min(MAX_SCALE, Math.max(1, next.scale));
    if (!box || scale === 1) return FIT;
    const reachX = ((scale - 1) * box.width) / 2;
    const reachY = ((scale - 1) * box.height) / 2;
    return {
      scale,
      x: Math.min(reachX, Math.max(-reachX, next.x)),
      y: Math.min(reachY, Math.max(-reachY, next.y)),
    };
  };

  /** Zooms so that the point under (x, y) stays under it. */
  const zoomAt = (from: View, scale: number, x: number, y: number): View => {
    const ratio = Math.min(MAX_SCALE, Math.max(1, scale)) / from.scale;
    return settle({
      scale: from.scale * ratio,
      x: x - (x - from.x) * ratio,
      y: y - (y - from.y) * ratio,
    });
  };

  const begin = () => {
    const points = [...pointers.current.values()];
    if (points.length === 0) {
      gesture.current = null;
      return;
    }
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const distance =
      points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    gesture.current = { view: latest.current, x, y, distance };
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, fromCentre(event.clientX, event.clientY));
    begin();
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, fromCentre(event.clientX, event.clientY));
    const start = gesture.current;
    const points = [...pointers.current.values()];
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    if (points.length > 1 && start.distance > 0) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const zoomed = zoomAt(
        start.view,
        (start.view.scale * distance) / start.distance,
        start.x,
        start.y,
      );
      setView(settle({ ...zoomed, x: zoomed.x + x - start.x, y: zoomed.y + y - start.y }));
    } else if (start.view.scale > 1) {
      setView(
        settle({ ...start.view, x: start.view.x + x - start.x, y: start.view.y + y - start.y }),
      );
    }
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    const point = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    const moved =
      gesture.current && point
        ? Math.hypot(point.x - gesture.current.x, point.y - gesture.current.y)
        : 0;
    if (point && pointers.current.size === 0 && moved < 8 && event.type === "pointerup") {
      // Two taps in a row zoom in on the spot, or back out.
      if (event.timeStamp - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        setView((now) => (now.scale > 1 ? FIT : zoomAt(now, 3, point.x, point.y)));
      } else {
        lastTap.current = event.timeStamp;
      }
    }
    begin();
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    // React's own wheel listener is passive, and a passive one cannot stop the page from scrolling.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = fromCentre(event.clientX, event.clientY);
      setView((now) => zoomAt(now, now.scale * Math.exp(-event.deltaY / 240), point.x, point.y));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  return (
    <div className="relative h-full bg-well">
      <div
        ref={frame}
        className="flex h-full touch-none items-center justify-center overflow-hidden p-3 select-none"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          className="max-h-full max-w-full object-contain will-change-transform"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onLoad={(event) =>
            onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
          }
        />
      </div>
      <div className="absolute right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center gap-1 rounded-xl border bg-popover/95 p-1">
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Zoom out"
          disabled={view.scale <= 1}
          onClick={() => setView((now) => zoomAt(now, now.scale / 1.5, 0, 0))}
        >
          <MinusIcon />
        </Button>
        <span className="w-12 text-center font-mono text-xs text-muted-foreground tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Zoom in"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => setView((now) => zoomAt(now, now.scale * 1.5, 0, 0))}
        >
          <PlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Fit to the screen"
          disabled={view.scale === 1}
          onClick={() => setView(FIT)}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}
