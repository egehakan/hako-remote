// Keeps a terminal's output in order. Every output frame carries the offset of its first byte in
// the session's stream, so a frame that does not start where the last one ended reveals a loss.

export type SeqVerdict =
  /** Write the frame's bytes from `offset` on (above zero when the snapshot covered its start). */
  | { kind: "apply"; offset: number }
  /** Already on screen, or nothing is expected yet. */
  | { kind: "skip" }
  /** Bytes are missing: subscribe again and replace the screen. */
  | { kind: "gap" };

export class SeqTracker {
  /** The offset the next byte must have, or null before the first snapshot. */
  private next: number | null = null;

  /** Starts over from a snapshot that covers every byte before `seq`. */
  reset(seq: number): void {
    this.next = seq;
  }

  /** Stops expecting output until the next snapshot. */
  clear(): void {
    this.next = null;
  }

  accept(seq: number, length: number): SeqVerdict {
    if (this.next === null) return { kind: "skip" };
    if (seq > this.next) return { kind: "gap" };
    const end = seq + length;
    if (end <= this.next) return { kind: "skip" };
    const offset = this.next - seq;
    this.next = end;
    return { kind: "apply", offset };
  }
}
