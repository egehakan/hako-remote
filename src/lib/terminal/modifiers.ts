// The sticky Ctrl and Alt of the key bar: a phone has no way to hold one key while pressing another.

export type Sticky = "off" | "armed" | "locked";
export type StickyKey = "ctrl" | "alt";
export type StickyState = Record<StickyKey, Sticky>;

export const NO_STICKY: StickyState = { ctrl: "off", alt: "off" };

/** A tap arms the modifier for the next key; a second tap, or a tap while locked, lets it go. */
export function tapSticky(state: StickyState, key: StickyKey): StickyState {
  return { ...state, [key]: state[key] === "off" ? "armed" : "off" };
}

/** A long press keeps the modifier down until it is tapped again. */
export function lockSticky(state: StickyState, key: StickyKey): StickyState {
  return { ...state, [key]: "locked" };
}

export function activeSticky(state: StickyState): { ctrl: boolean; alt: boolean } {
  return { ctrl: state.ctrl !== "off", alt: state.alt !== "off" };
}

/** The state after a key was sent: an armed modifier is used up, a locked one stays. */
export function consumeSticky(state: StickyState): StickyState {
  if (state.ctrl !== "armed" && state.alt !== "armed") return state;
  return {
    ctrl: state.ctrl === "armed" ? "off" : state.ctrl,
    alt: state.alt === "armed" ? "off" : state.alt,
  };
}
