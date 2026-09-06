import { join } from "node:path";
import { createApp, type AppOptions } from "./app.js";
import { LocalBlobStore } from "./blob-store.js";
import { S3BlobStore, type S3BlobStoreOptions } from "./s3-blob-store.js";
import type { BlobStore } from "./storage.js";
import { connectValkeyRaiseStore } from "./valkey-store.js";

export type RuntimeBlobConfig =
  { driver: "local" } | ({ driver: "s3" } & Omit<S3BlobStoreOptions, "client">);

export interface RuntimeAppOptions extends AppOptions {
  dataDir: string;
  valkeyUrl: string;
  blob: RuntimeBlobConfig;
}

export function reportValkeyConnectionError(_error: Error): void {
  // Connection errors can contain credentials from the configured URL.
  console.error("Valkey connection failed.");
}

async function createRuntimeBlobStore(options: RuntimeAppOptions): Promise<BlobStore> {
  if (options.blob.driver === "s3") {
    const { bucket, clientConfig, maxDownloadBytes } = options.blob;
    return new S3BlobStore({
      bucket,
      ...(clientConfig ? { clientConfig } : {}),
      ...(maxDownloadBytes === undefined ? {} : { maxDownloadBytes }),
    });
  }
  const blobs = new LocalBlobStore(join(options.dataDir, "blobs"));
  await blobs.start();
  return blobs;
}

export async function createRuntimeApp(options: RuntimeAppOptions) {
  let blobs: BlobStore | undefined;
  let raises: Awaited<ReturnType<typeof connectValkeyRaiseStore>> | undefined;

  try {
    blobs = await createRuntimeBlobStore(options);
    raises = await connectValkeyRaiseStore({
      url: options.valkeyUrl,
      onError: reportValkeyConnectionError,
    });
    return await createApp(options, { raises, blobs });
  } catch (error) {
    await Promise.allSettled([raises?.close(), blobs?.close()]);
    throw error;
  }
}
