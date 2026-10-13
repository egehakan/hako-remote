// Binary terminal output frame, as laid out in docs/protocol.md.

export const OUTPUT_FRAME_TYPE = 0x01;

export type OutputFrame = { sessionId: string; seq: number; payload: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeOutputFrame(sessionId: string, seq: number, payload: Uint8Array): Uint8Array {
  const id = encoder.encode(sessionId);
  if (id.length === 0 || id.length > 255) {
    throw new RangeError("session id must be 1 to 255 bytes");
  }
  const frame = new Uint8Array(2 + id.length + 8 + payload.length);
  frame[0] = OUTPUT_FRAME_TYPE;
  frame[1] = id.length;
  frame.set(id, 2);
  new DataView(frame.buffer).setBigUint64(2 + id.length, BigInt(seq));
  frame.set(payload, 2 + id.length + 8);
  return frame;
}

/** Reads only the session id, which is all the relay needs to route a frame. */
export function readOutputFrameSessionId(frame: Uint8Array): string | null {
  if (frame.length < 2 || frame[0] !== OUTPUT_FRAME_TYPE) return null;
  const n = frame[1];
  if (n === 0 || frame.length < 2 + n + 8) return null;
  try {
    return decoder.decode(frame.subarray(2, 2 + n));
  } catch {
    return null;
  }
}

export function decodeOutputFrame(frame: Uint8Array): OutputFrame | null {
  const sessionId = readOutputFrameSessionId(frame);
  if (sessionId === null) return null;
  const n = frame[1];
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = Number(view.getBigUint64(2 + n));
  return { sessionId, seq, payload: frame.subarray(2 + n + 8) };
}
