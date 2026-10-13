import { type ComponentProps, type PointerEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type KeyButtonProps = Omit<ComponentProps<"button">, "onClick" | "type"> & {
  onPress: () => void;
  /** Fires again and again while held, as a keyboard key does. */
  repeat?: boolean;
  /** Called once when the key is held instead of tapped. */
  onHold?: () => void;
  tone?: "key" | "accent" | "armed";
};

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 70;
const HOLD_MS = 450;

const TONES = {
  key: "bg-secondary text-secondary-foreground hover:bg-input/60 active:bg-input",
  accent: "bg-secondary text-lid hover:bg-input/60 active:bg-input",
  armed: "bg-amber text-primary-foreground",
} as const;

/** How a key of the key bar looks, for the one key that has to be a plain button. */
export function keyClasses(tone: keyof typeof TONES = "key"): string {
  return cn(
    "flex h-10 min-w-0 touch-manipulation items-center justify-center rounded-md font-mono text-[0.8125rem] leading-none outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-40 [&_svg]:size-[1.125rem] [&_svg]:shrink-0",
    TONES[tone],
  );
}

/**
 * One key of the key bar. It acts on the pointer instead of on click, and never takes focus, so the
 * on-screen keyboard stays open and the terminal keeps its text field.
 */
export function KeyButton({
  onPress,
  repeat = false,
  onHold,
  tone = "key",
  className,
  disabled,
  children,
  ...props
}: KeyButtonProps) {
  const timers = useRef<{ delay?: number; every?: number; hold?: number }>({});
  const down = useRef(false);
  const held = useRef(false);

  const clear = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.every);
    window.clearTimeout(timers.current.hold);
    down.current = false;
  };
  useEffect(() => clear, []);

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    down.current = true;
    held.current = false;
    if (repeat) {
      onPress();
      timers.current.delay = window.setTimeout(() => {
        timers.current.every = window.setInterval(onPress, REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS);
    } else if (onHold) {
      timers.current.hold = window.setTimeout(() => {
        held.current = true;
        onHold();
      }, HOLD_MS);
    }
  };

  const release = (event: PointerEvent<HTMLButtonElement>) => {
    if (!down.current) return;
    clear();
    if (repeat || held.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (inside) onPress();
  };

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(keyClasses(tone), className)}
      // Stops the press from moving focus away from the terminal's text field.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={clear}
      onContextMenu={(event) => event.preventDefault()}
      // A click without a pointer comes from a keyboard or an assistive tool.
      onClick={(event) => {
        if (event.detail === 0) onPress();
      }}
      {...props}
    >
      {children}
    </button>
  );
}
