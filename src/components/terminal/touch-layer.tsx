import { type PointerEvent, useEffect, useRef } from "react";
import type { TerminalController } from "@/lib/terminal/controller";

type TouchLayerProps = {
  controller: TerminalController;
  /** The element xterm draws into, which is stretched while two fingers pinch. */
  host: HTMLElement;
  /** A tap: the place to open the keyboard. */
  onTap: () => void;
  onLongPress: () => void;
  /** Two fingers let go after changing their distance by `scale`, around `x`, `y` of the layer. */
  onPinch: (scale: number, x: number, y: number) => void;
};

type Point = { x: number; y: number };

const DRAG_SLOP_PX = 8;
const LONG_PRESS_MS = 550;
const FLICK_MIN_SPEED = 0.25;
const COAST_STOP_SPEED = 0.02;
/** In pixels per millisecond. A flick faster than this is a glitch in the timestamps. */
const COAST_MAX_SPEED = 4;
/** How much of its speed a coasting scroll keeps per millisecond. */
const COAST_FRICTION = 0.9965;

/**
 * Takes every touch on the terminal: one finger scrolls (and coasts after a flick), two fingers
 * zoom, a tap asks for the keyboard and a long press for text selection. xterm itself never sees
 * the touches, so it cannot mistake them for mouse clicks meant for the program.
 */
export function TouchLayer({ controller, host, onTap, onLongPress, onPinch }: TouchLayerProps) {
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef({
    start: { x: 0, y: 0 },
    /** A drag that starts clearly along one axis stays on it, as native scrolling does. */
    axis: "free" as "free" | "x" | "y",
    moved: false,
    pinching: false,
    pinchStart: 0,
    pinchScale: 1,
    pinchAt: { x: 0, y: 0 },
    lastTime: 0,
    speed: 0,
    longPressed: false,
  });
  const longPress = useRef<number | undefined>(undefined);
  const coast = useRef(0);

  const stopCoasting = () => {
    cancelAnimationFrame(coast.current);
    coast.current = 0;
  };
  useEffect(
    () => () => {
      stopCoasting();
      window.clearTimeout(longPress.current);
    },
    [],
  );

  const distance = (): number => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; the gesture still ends on its pointerup or pointercancel.
    }
    stopCoasting();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const state = gesture.current;
    window.clearTimeout(longPress.current);
    if (pointers.current.size === 1) {
      state.start = { x: event.clientX, y: event.clientY };
      state.moved = false;
      state.pinching = false;
      state.longPressed = false;
      state.speed = 0;
      state.lastTime = event.timeStamp;
      longPress.current = window.setTimeout(() => {
        state.longPressed = true;
        onLongPress();
      }, LONG_PRESS_MS);
    } else if (pointers.current.size === 2) {
      state.pinching = true;
      state.moved = true;
      state.pinchStart = distance();
      state.pinchScale = 1;
      // Stretch around the point between the fingers, so the text under them stays under them.
      const [a, b] = [...pointers.current.values()];
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const box = host.getBoundingClientRect();
      const layer = event.currentTarget.getBoundingClientRect();
      host.style.transformOrigin = `${middle.x - box.left}px ${middle.y - box.top}px`;
      state.pinchAt = { x: middle.x - layer.left, y: middle.y - layer.top };
    }
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const state = gesture.current;

    if (state.pinching) {
      if (pointers.current.size === 2 && state.pinchStart > 0) {
        state.pinchScale = distance() / state.pinchStart;
        host.style.transform = `scale(${state.pinchScale})`;
      }
      return;
    }
    if (!state.moved) {
      // A finger that only wobbles is still tapping.
      const fromStartX = Math.abs(point.x - state.start.x);
      const fromStartY = Math.abs(point.y - state.start.y);
      if (Math.hypot(fromStartX, fromStartY) < DRAG_SLOP_PX) return;
      state.axis =
        fromStartY > fromStartX * 1.5 ? "y" : fromStartX > fromStartY * 1.5 ? "x" : "free";
      state.moved = true;
      state.lastTime = event.timeStamp;
      window.clearTimeout(longPress.current);
      return;
    }
    const dx = state.axis === "y" ? 0 : point.x - previous.x;
    const dy = state.axis === "x" ? 0 : point.y - previous.y;
    controller.surface.scrollBy(dx, dy);
    const elapsed = Math.max(1, event.timeStamp - state.lastTime);
    state.lastTime = event.timeStamp;
    // A running average, so one jittery sample does not decide how far a flick goes.
    state.speed = state.speed * 0.6 + (dy / elapsed) * 0.4;
  };

  const startCoasting = (speed: number) => {
    let velocity = Math.max(-COAST_MAX_SPEED, Math.min(COAST_MAX_SPEED, speed));
    let last = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(48, now - last);
      last = now;
      controller.surface.scrollBy(0, velocity * elapsed);
      velocity *= COAST_FRICTION ** elapsed;
      coast.current = Math.abs(velocity) > COAST_STOP_SPEED ? requestAnimationFrame(step) : 0;
    };
    coast.current = requestAnimationFrame(step);
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    window.clearTimeout(longPress.current);
    const state = gesture.current;
    if (state.pinching) {
      if (pointers.current.size > 0) return;
      state.pinching = false;
      host.style.transform = "";
      host.style.transformOrigin = "";
      if (Math.abs(state.pinchScale - 1) > 0.03) {
        onPinch(state.pinchScale, state.pinchAt.x, state.pinchAt.y);
      }
      return;
    }
    if (pointers.current.size > 0) return;
    if (!state.moved) return;
    const stale = event.timeStamp - state.lastTime > 80;
    if (!stale && Math.abs(state.speed) > FLICK_MIN_SPEED && !controller.surface.alternateScreen) {
      startCoasting(state.speed);
    }
  };

  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    window.clearTimeout(longPress.current);
    if (pointers.current.size === 0 && gesture.current.pinching) {
      gesture.current.pinching = false;
      host.style.transform = "";
      host.style.transformOrigin = "";
    }
  };

  return (
    <div
      className="absolute inset-0 touch-none select-none [-webkit-touch-callout:none]"
      // The click is what opens the keyboard: browsers only show one for a real tap.
      onClick={() => {
        const state = gesture.current;
        if (!state.moved && !state.longPressed) onTap();
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => {
        stopCoasting();
        controller.surface.scrollBy(-event.deltaX, -event.deltaY);
      }}
    >
      <span className="sr-only">
        Terminal screen. Tap to type. Swipe to scroll, pinch to zoom, hold to select text.
      </span>
    </div>
  );
}
