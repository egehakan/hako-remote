// Bytes to and from the base64 a piece travels as. Newer browsers have this built in; the others
// go through `btoa` and `atob`, a slice at a time so no call gets too many arguments.

const SLICE = 0x8000;

type NativeBytes = Uint8Array & { toBase64?: () => string };
type NativeDecoder = { fromBase64?: (text: string) => Uint8Array };

export function encodeBase64(bytes: Uint8Array): string {
  const native = (bytes as NativeBytes).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  for (let start = 0; start < bytes.length; start += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + SLICE));
  }
  return btoa(binary);
}

/** Throws for text that is not base64. */
export function decodeBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as NativeDecoder).fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
