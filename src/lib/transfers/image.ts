// Getting a picture ready to be attached in a terminal: its own bytes when Claude Code takes them
// as they are, and otherwise a new encoding drawn on a canvas. `image-plan.ts` decides which.

import { JPEG_QUALITY, planImage, sniffImageType } from "./image-plan";

export type PreparedImage = { name: string; blob: Blob };

/** Thrown for a file this browser cannot draw, with a sentence for the owner. */
export class ImageProblem extends Error {}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("not a picture this browser can draw"));
    image.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

/**
 * A browser applies a photograph's orientation when it draws it, and reports the picture's width
 * and height as drawn, so what comes off the canvas is upright whichever way the phone was held.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const type = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const url = URL.createObjectURL(file);
  try {
    let image: HTMLImageElement;
    try {
      image = await load(url);
    } catch {
      // One of the four formats that this browser will not draw is still the Mac's to read.
      if (type !== null)
        return { name: planImage({ name: file.name, type, width: 0, height: 0 }).name, blob: file };
      throw new ImageProblem(
        `${file.name} is in a format this browser can’t convert. Send a PNG or a JPEG instead.`,
      );
    }
    const plan = planImage({
      name: file.name,
      type,
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
    if (plan.action === "keep") return { name: plan.name, blob: file };

    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) throw new ImageProblem(`${file.name} could not be converted on this device.`);
    if (plan.type === "image/jpeg") {
      // A JPEG has no transparency; what was see-through would otherwise come out black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, plan.width, plan.height);
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, plan.width, plan.height);
    const blob = await encode(canvas, plan.type);
    // Releases the canvas's memory at once, which an iPhone is short of.
    canvas.width = canvas.height = 0;
    if (!blob || blob.type !== plan.type) {
      throw new ImageProblem(`${file.name} could not be converted on this device.`);
    }
    return { name: plan.name, blob };
  } finally {
    URL.revokeObjectURL(url);
  }
}
