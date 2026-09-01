import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentInput } from "@raise/protocol";
import sharp, { type OutputInfo } from "sharp";
import { HttpError } from "./errors.js";
import type { RaiseDatabase } from "./database.js";

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 15_728_640);

export async function storeImages(options: {
  db: RaiseDatabase;
  dataDir: string;
  raiseId: string;
  entryId: string;
  images: AttachmentInput[];
}) {
  if (!options.images.length) return;
  const blobDir = join(options.dataDir, "blobs");
  await mkdir(blobDir, { recursive: true });

  for (const image of options.images) {
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

    let rendered: { data: Buffer; info: OutputInfo };
    try {
      rendered = await sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 })
        .rotate()
        .webp({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new HttpError(
        400,
        "invalid_image",
        `We couldn't read ${image.name}. Try a different PNG, JPEG, or WebP file.`,
      );
    }

    const attachmentId = `img_${randomBytes(9).toString("base64url")}`;
    const storageKey = join(blobDir, `${attachmentId}.webp`);
    await writeFile(storageKey, rendered.data, { flag: "wx" });
    options.db.addAttachment({
      id: attachmentId,
      entryId: options.entryId,
      raiseId: options.raiseId,
      displayName: image.name.replace(/[\\/]/g, "_").slice(0, 180),
      storageKey,
      size: rendered.data.length,
      width: rendered.info.width,
      height: rendered.info.height,
    });
  }
}
