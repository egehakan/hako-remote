// What to do with a picture before it is attached in a terminal. Claude Code takes PNG, JPEG, GIF
// and WebP, and a phone hands over HEIC and photographs far larger than a model looks at.

/** The longer side, in pixels, beyond which a picture is scaled down. */
export const MAX_IMAGE_SIDE = 2576;
export const JPEG_QUALITY = 0.9;

export type AcceptedType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXTENSIONS: Record<AcceptedType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const SAME_TYPE: Record<string, AcceptedType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte);
}

/**
 * Which of the four accepted formats a file is, read from its first bytes, or null for anything
 * else. The name and the type a browser reports follow the extension, which a renamed file has
 * wrong; twelve bytes are enough to know.
 */
export function sniffImageType(head: Uint8Array): AcceptedType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** `name` with the extension that says what the file is. */
export function withExtension(name: string, type: AcceptedType): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (SAME_TYPE[current] === type) return name;
  return `${stem === "" ? "image" : stem}.${EXTENSIONS[type]}`;
}

export type ImagePlan =
  /** Send the file's own bytes, under `name`. */
  | { action: "keep"; name: string }
  /** Draw the picture at `width` by `height` and send that, as `type`, under `name`. */
  | {
      action: "encode";
      type: "image/jpeg" | "image/png";
      width: number;
      height: number;
      name: string;
    };

/**
 * Decides between a picture's own bytes and a new encoding of it. `type` is what its first bytes
 * say, and `width` and `height` are as it is displayed, with its orientation applied.
 *
 * - One of the four formats and no side over the limit: kept as it is, bytes untouched.
 * - Any other format: drawn again as a JPEG, scaled down when it is over the limit.
 * - One of the four but too large: scaled down, as a PNG when the original may have transparency
 *   or sharp edges worth keeping (PNG, GIF, WebP), and as a JPEG when it was one.
 */
export function planImage(input: {
  name: string;
  type: AcceptedType | null;
  width: number;
  height: number;
}): ImagePlan {
  const { name, type } = input;
  const longer = Math.max(input.width, input.height);
  if (type !== null && longer <= MAX_IMAGE_SIDE) {
    return { action: "keep", name: withExtension(name, type) };
  }
  const scale = longer > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / longer : 1;
  const encoded = type === null || type === "image/jpeg" ? "image/jpeg" : "image/png";
  return {
    action: "encode",
    type: encoded,
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale)),
    name: withExtension(name, encoded),
  };
}
