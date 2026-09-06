import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { BlobStore, BlobWrite } from "./storage.js";

// A 15 MiB image can grow to roughly 20 MiB once its encrypted envelope is
// base64 encoded. Keep downloads bounded while leaving room for that overhead.
export const DEFAULT_MAX_BLOB_DOWNLOAD_BYTES = 24 * 1_024 * 1_024;

type S3BlobCommand = PutObjectCommand | GetObjectCommand | DeleteObjectCommand;

/** The small client surface keeps the adapter testable without an S3 server. */
export interface S3BlobCommandClient {
  send(command: S3BlobCommand): Promise<unknown>;
  destroy?(): void | Promise<void>;
}

export interface S3BlobStoreOptions {
  bucket: string;
  client?: S3BlobCommandClient;
  clientConfig?: S3ClientConfig;
  maxDownloadBytes?: number;
}

export class S3BlobNotFoundError extends Error {
  readonly code = "ENOENT";

  constructor() {
    super("Blob not found.");
    this.name = "S3BlobNotFoundError";
  }
}

export class S3BlobTooLargeError extends Error {
  readonly code = "EFBIG";

  constructor(readonly maxBytes: number) {
    super(`Blob exceeds the ${maxBytes}-byte download limit.`);
    this.name = "S3BlobTooLargeError";
  }
}

export class S3BlobStoreError extends Error {
  constructor(readonly operation: "put" | "get" | "delete" | "close") {
    // Provider errors can include configured endpoints. Deliberately do not
    // attach or interpolate the original error, which could contain secrets.
    super(`Private object storage ${operation} failed.`);
    this.name = "S3BlobStoreError";
  }
}

interface DownloadOutput {
  Body?: unknown;
  ContentLength?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingObject(error: unknown): boolean {
  try {
    if (!isRecord(error)) return false;
    if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
    const metadata = error.$metadata;
    return isRecord(metadata) && metadata.httpStatusCode === 404;
  } catch {
    return false;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && Symbol.asyncIterator in value;
}

function byteChunk(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return undefined;
}

async function stopBody(body: unknown): Promise<void> {
  if (!isRecord(body)) return;
  try {
    if (typeof body.destroy === "function") {
      body.destroy();
      return;
    }
    if (typeof body.cancel === "function") await body.cancel();
  } catch {
    // The original bounded-read error is more useful than cleanup failure.
  }
}

async function readBoundedBody(
  body: unknown,
  declaredLength: number | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const direct = byteChunk(body);
  if (direct) {
    if (direct.byteLength > maxBytes) throw new S3BlobTooLargeError(maxBytes);
    if (declaredLength !== undefined && direct.byteLength !== declaredLength) {
      throw new S3BlobStoreError("get");
    }
    return Buffer.from(direct);
  }

  if (!isAsyncIterable(body)) {
    await stopBody(body);
    throw new S3BlobStoreError("get");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of body) {
      const chunk = byteChunk(value);
      if (!chunk) throw new S3BlobStoreError("get");
      total += chunk.byteLength;
      if (total > maxBytes) throw new S3BlobTooLargeError(maxBytes);
      chunks.push(chunk);
    }
    if (declaredLength !== undefined && total !== declaredLength) {
      throw new S3BlobStoreError("get");
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await stopBody(body);
    if (error instanceof S3BlobStoreError || error instanceof S3BlobTooLargeError) throw error;
    throw new S3BlobStoreError("get");
  }
}

function declaredLength(output: DownloadOutput): number | undefined {
  if (output.ContentLength === undefined) return undefined;
  if (
    typeof output.ContentLength !== "number" ||
    !Number.isSafeInteger(output.ContentLength) ||
    output.ContentLength < 0
  ) {
    throw new S3BlobStoreError("get");
  }
  return output.ContentLength;
}

function defaultClient(config: S3ClientConfig | undefined): S3BlobCommandClient {
  const client = new S3Client(config ?? {});
  return {
    send(command) {
      if (command instanceof PutObjectCommand) return client.send(command);
      if (command instanceof GetObjectCommand) return client.send(command);
      return client.send(command);
    },
    destroy() {
      client.destroy();
    },
  };
}

export class S3BlobStore implements BlobStore {
  private readonly bucket: string;
  private readonly client: S3BlobCommandClient;
  private readonly maxDownloadBytes: number;
  private closed = false;

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket.trim()) throw new Error("An object storage bucket is required.");
    const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_BLOB_DOWNLOAD_BYTES;
    if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
      throw new Error("The object storage download limit must be a positive integer.");
    }

    this.bucket = options.bucket;
    this.maxDownloadBytes = maxDownloadBytes;
    this.client = options.client ?? defaultClient(options.clientConfig);
  }

  async put(input: BlobWrite): Promise<void> {
    this.assertOpen();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        }),
      );
    } catch {
      throw new S3BlobStoreError("put");
    }
  }

  async get(key: string): Promise<Buffer> {
    this.assertOpen();
    let output: unknown;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isMissingObject(error)) throw new S3BlobNotFoundError();
      throw new S3BlobStoreError("get");
    }

    try {
      if (!isRecord(output)) throw new S3BlobStoreError("get");
      const body = output.Body;
      const length = declaredLength(output);
      if (length !== undefined && length > this.maxDownloadBytes) {
        await stopBody(body);
        throw new S3BlobTooLargeError(this.maxDownloadBytes);
      }
      return await readBoundedBody(body, length, this.maxDownloadBytes);
    } catch (error) {
      if (error instanceof S3BlobStoreError || error instanceof S3BlobTooLargeError) throw error;
      throw new S3BlobStoreError("get");
    }
  }

  async delete(key: string): Promise<void> {
    this.assertOpen();
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isMissingObject(error)) return;
      throw new S3BlobStoreError("delete");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.destroy?.();
    } catch {
      throw new S3BlobStoreError("close");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Object storage client is closed.");
  }
}
