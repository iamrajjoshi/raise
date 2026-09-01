import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maxAttachmentBytesPerEntry, type AttachmentInput } from "@raise/protocol";
import sharp from "sharp";
import { HttpError } from "./errors.js";
import type { RaiseDatabase } from "./database.js";

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 15_728_640);

export interface PreparedImage {
  displayName: string;
  data: Buffer;
  width: number;
  height: number;
}

export async function prepareImages(images: AttachmentInput[]): Promise<PreparedImage[]> {
  const prepared: PreparedImage[] = [];
  let totalSourceBytes = 0;

  for (const image of images) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      image.dataUrl,
    );
    if (!match || match[1] !== image.mimeType) {
      throw new HttpError(400, "invalid_image", `${image.name} must be a PNG, JPEG, or WebP file.`);
    }
    const source = Buffer.from(match[2] as string, "base64");
    if (!source.length || source.length > MAX_IMAGE_BYTES) {
      const maxMegabytes = Math.floor(MAX_IMAGE_BYTES / 1_048_576);
      throw new HttpError(
        413,
        "image_too_large",
        `${image.name} is larger than ${maxMegabytes} MB. Choose a smaller file.`,
      );
    }
    totalSourceBytes += source.length;
    if (totalSourceBytes > maxAttachmentBytesPerEntry) {
      const maxMegabytes = Math.floor(maxAttachmentBytesPerEntry / 1_048_576);
      throw new HttpError(
        413,
        "images_too_large",
        `Those screenshots add up to more than ${maxMegabytes} MB. Use smaller copies or remove one.`,
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
        `We couldn't read ${image.name}. Try a different PNG, JPEG, or WebP file.`,
      );
    }
  }

  return prepared;
}

export async function storeImages(options: {
  db: RaiseDatabase;
  dataDir: string;
  raiseId: string;
  entryId: string;
  images: PreparedImage[];
}) {
  if (!options.images.length) return;
  const blobDir = join(options.dataDir, "blobs");
  await mkdir(blobDir, { recursive: true });

  for (const image of options.images) {
    const attachmentId = `img_${randomBytes(9).toString("base64url")}`;
    const storageKey = join(blobDir, `${attachmentId}.webp`);
    await writeFile(storageKey, image.data, { flag: "wx" });
    try {
      options.db.addAttachment({
        id: attachmentId,
        entryId: options.entryId,
        raiseId: options.raiseId,
        displayName: image.displayName,
        storageKey,
        size: image.data.length,
        width: image.width,
        height: image.height,
      });
    } catch (error) {
      await unlink(storageKey).catch(() => undefined);
      throw error;
    }
  }
}
