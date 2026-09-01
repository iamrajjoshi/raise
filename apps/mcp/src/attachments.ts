import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import {
  maxAttachmentBytesPerEntry,
  maxAttachmentsPerEntry,
  type AttachmentInput,
} from "@raise/protocol";

const types: Record<string, AttachmentInput["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function attachmentsFromPaths(paths: string[]) {
  if (paths.length > maxAttachmentsPerEntry) {
    throw new Error(`Add no more than ${maxAttachmentsPerEntry} screenshots at once.`);
  }
  const attachments: AttachmentInput[] = [];
  let total = 0;
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Screenshot paths must be absolute: ${path}`);
    const mimeType = types[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`${basename(path)} must be a PNG, JPEG, or WebP image.`);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${path} is not a file.`);
    total += info.size;
    if (total > maxAttachmentBytesPerEntry) {
      throw new Error("Those screenshots are over the 15 MB limit together.");
    }
    const data = await readFile(path);
    attachments.push({
      name: basename(path),
      mimeType,
      dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    });
  }
  return attachments;
}
