import { cn } from "@/lib/utils";

type BoxMarkProps = {
  /** `lit` is the mark in its own colours, `dark` an unlit box, `seeking` an unlit box trying its lid. */
  state?: "lit" | "dark" | "seeking";
  className?: string;
};

const VIEW_BOX = "212 172 600 720";

/** The Hako box. Its lid sits in a wrapper of its own so it can move without redrawing the body. */
export function BoxMark({ state = "lit", className }: BoxMarkProps) {
  const lit = state === "lit";
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-block aspect-[5/6] shrink-0", className)}
    >
      <svg viewBox={VIEW_BOX} className="absolute inset-0 size-full">
        <polygon
          points="262,416 512,560 512,848 262,704"
          className={cn("transition-colors duration-500", lit ? "fill-amber" : "fill-input")}
        />
        <polygon
          points="512,560 762,416 762,704 512,848"
          className={cn("transition-colors duration-500", lit ? "fill-ember" : "fill-border")}
        />
      </svg>
      <span
        className={cn("absolute inset-0", state === "seeking" && "motion-safe:animate-lid-lift")}
      >
        <svg viewBox={VIEW_BOX} className="size-full">
          <polygon
            points="512,208 762,352 512,496 262,352"
            className={cn("transition-colors duration-500", lit ? "fill-lid" : "fill-faint")}
          />
        </svg>
      </span>
    </span>
  );
}
