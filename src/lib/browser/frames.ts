// Pictures of the Mac's page on their way to the screen. One is decoded at a time; while it is, a
// newer one replaces the one waiting, so a slow phone always draws the latest picture and never
// falls behind. Every frame is acknowledged, after the picture that follows it has been drawn, so
// the Mac sends no faster than this screen draws.

import type { BrowserFrame } from "../../../shared/browser.ts";

export type FrameDeps<Picture> = {
  decode: (frame: BrowserFrame) => Promise<Picture>;
  draw: (picture: Picture, frame: BrowserFrame) => void;
  /** Frees what a decoded picture holds once it is drawn (an `ImageBitmap`). */
  release: (picture: Picture) => void;
  ack: (bid: number, frame: number) => void;
};

export class FramePipeline<Picture> {
  private readonly deps: FrameDeps<Picture>;
  private busy = false;
  private waiting: BrowserFrame | null = null;
  /** Frames replaced before they were drawn, in the order they came, acknowledged with the next. */
  private skipped: BrowserFrame[] = [];
  /** Bumped by `reset`, so a decode that finishes for an old session does nothing. */
  private generation = 0;

  constructor(deps: FrameDeps<Picture>) {
    this.deps = deps;
  }

  push(frame: BrowserFrame): void {
    if (!this.busy) {
      void this.run(frame);
      return;
    }
    if (this.waiting) this.skipped.push(this.waiting);
    this.waiting = frame;
  }

  /** Forgets everything on its way, for a session that has ended. Nothing more is acknowledged. */
  reset(): void {
    this.generation += 1;
    this.busy = false;
    this.waiting = null;
    this.skipped = [];
  }

  private async run(frame: BrowserFrame): Promise<void> {
    const generation = this.generation;
    this.busy = true;
    // Frames replaced while waiting came before this one; those replaced from now on come after it.
    const passedOver = this.skipped;
    this.skipped = [];
    let picture: Picture | null = null;
    try {
      picture = await this.deps.decode(frame);
    } catch {
      // A picture that cannot be decoded is passed over; the next one replaces it.
    }
    if (generation !== this.generation) {
      if (picture !== null) this.deps.release(picture);
      return;
    }
    if (picture !== null) {
      try {
        this.deps.draw(picture, frame);
      } catch {
        // A canvas that is gone; the frame is still acknowledged, so the Mac goes on.
      } finally {
        this.deps.release(picture);
      }
    }
    for (const passed of passedOver) this.deps.ack(passed.bid, passed.frame);
    this.deps.ack(frame.bid, frame.frame);
    this.busy = false;
    const next = this.waiting;
    this.waiting = null;
    if (next) void this.run(next);
  }
}
