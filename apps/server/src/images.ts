import { maxAttachmentBytesPerEntry, type AttachmentInput } from "@raise/protocol";
import sharp from "sharp";
import { HttpError } from "./errors.js";

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 15_728_640);

export interface PreparedImage {
  displayName: string;
  data: Buffer;
  width: number;
  height: number;
}

function detectedMimeType(source: Buffer): AttachmentInput["mimeType"] | undefined {
  if (
    source.length >= 8 &&
    source.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (source.length >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    source.length >= 12 &&
    source.subarray(0, 4).toString("ascii") === "RIFF" &&
    source.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function renderAgentPreview(source: Buffer) {
  return sharp(source)
    .resize({ width: 1_600, height: 1_600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

export async function prepareImages(images: AttachmentInput[]): Promise<PreparedImage[]> {
  const prepared: PreparedImage[] = [];
  let totalSourceBytes = 0;

  for (const image of images) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      image.dataUrl,
    );
    const declaredMimeType = match?.[1];
    const encodedSource = match?.[2];
    if (declaredMimeType !== image.mimeType || encodedSource === undefined) {
      throw new HttpError(400, "invalid_image", `${image.name} isn’t a PNG, JPEG, or WebP image.`);
    }
    const source = Buffer.from(encodedSource, "base64");
    if (!source.length || source.length > MAX_IMAGE_BYTES) {
      const maxMegabytes = Math.floor(MAX_IMAGE_BYTES / 1_048_576);
      throw new HttpError(
        413,
        "image_too_large",
        `${image.name} is over ${maxMegabytes} MB. Try a smaller copy.`,
      );
    }
    if (detectedMimeType(source) !== image.mimeType) {
      throw new HttpError(400, "invalid_image", `${image.name} isn’t a PNG, JPEG, or WebP image.`);
    }
    totalSourceBytes += source.length;
    if (totalSourceBytes > maxAttachmentBytesPerEntry) {
      const maxMegabytes = Math.floor(maxAttachmentBytesPerEntry / 1_048_576);
      throw new HttpError(
        413,
        "images_too_large",
        `Those screenshots are over the ${maxMegabytes} MB limit together. Try smaller copies or remove one.`,
      );
    }

    try {
      const rendered = await sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 })
        .rotate()
        .webp({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
      prepared.push({
        displayName: image.name.replace(/[\\/]/g, "_").slice(0, 180),
        data: rendered.data,
        width: rendered.info.width,
        height: rendered.info.height,
      });
    } catch {
      throw new HttpError(
        400,
        "invalid_image",
        `${image.name} doesn’t look like a valid PNG, JPEG, or WebP image.`,
      );
    }
  }

  return prepared;
}
