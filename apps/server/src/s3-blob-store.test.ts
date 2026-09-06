import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BLOB_DOWNLOAD_BYTES,
  S3BlobNotFoundError,
  S3BlobStore,
  S3BlobStoreError,
  S3BlobTooLargeError,
  type S3BlobCommandClient,
} from "./s3-blob-store.js";

class MockS3Client implements S3BlobCommandClient {
  readonly commands: Array<PutObjectCommand | GetObjectCommand | DeleteObjectCommand> = [];
  readonly responses: unknown[] = [];
  destroyCalls = 0;

  async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? {};
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

function store(client: MockS3Client, maxDownloadBytes = DEFAULT_MAX_BLOB_DOWNLOAD_BYTES) {
  return new S3BlobStore({
    bucket: "private-raise-blobs",
    client,
    maxDownloadBytes,
  });
}

describe("S3BlobStore", () => {
  it("allows encrypted-envelope expansion but keeps a fixed default ceiling", () => {
    expect(DEFAULT_MAX_BLOB_DOWNLOAD_BYTES).toBe(24 * 1_024 * 1_024);
  });

  it("puts caller-owned opaque keys as private binary objects", async () => {
    const client = new MockS3Client();
    const blobs = store(client);
    const bytes = Buffer.from("encrypted envelope");
    const key = "ephemeral/v1/opaque+key==";

    await blobs.put({ key, bytes });

    const command = client.commands[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toEqual({
      Bucket: "private-raise-blobs",
      Key: key,
      Body: bytes,
      ContentType: "application/octet-stream",
      IfNoneMatch: "*",
    });
    expect(command?.input).not.toHaveProperty("ACL");
  });

  it("reads byte-array bodies without returning provider-owned memory", async () => {
    const client = new MockS3Client();
    const source = Uint8Array.from([1, 2, 3, 4]);
    client.responses.push({ Body: source, ContentLength: source.byteLength });

    const result = await store(client).get("opaque-key");

    expect(result).toEqual(Buffer.from(source));
    source[0] = 9;
    expect(result[0]).toBe(1);
    expect(client.commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(client.commands[0]?.input).toEqual({
      Bucket: "private-raise-blobs",
      Key: "opaque-key",
    });
  });

  it("streams a download while enforcing the byte limit", async () => {
    const client = new MockS3Client();
    client.responses.push({
      Body: Readable.from([Buffer.from("abc"), Buffer.from("def")]),
      ContentLength: 6,
    });

    await expect(store(client, 6).get("opaque-key")).resolves.toEqual(Buffer.from("abcdef"));
  });

  it("rejects declared and streamed bodies over the configured limit", async () => {
    const declaredClient = new MockS3Client();
    const declaredBody = Readable.from([Buffer.from("abcdef")]);
    declaredClient.responses.push({ Body: declaredBody, ContentLength: 7 });
    await expect(store(declaredClient, 6).get("opaque-key")).rejects.toBeInstanceOf(
      S3BlobTooLargeError,
    );
    expect(declaredBody.destroyed).toBe(true);

    const streamedClient = new MockS3Client();
    const streamedBody = Readable.from([Buffer.from("abc"), Buffer.from("defg")]);
    streamedClient.responses.push({ Body: streamedBody });
    await expect(store(streamedClient, 6).get("opaque-key")).rejects.toMatchObject({
      code: "EFBIG",
      maxBytes: 6,
    });
    expect(streamedBody.destroyed).toBe(true);
  });

  it("rejects missing, malformed, and truncated response bodies", async () => {
    const missingBody = new MockS3Client();
    missingBody.responses.push({ ContentLength: 2 });
    await expect(store(missingBody).get("opaque-key")).rejects.toBeInstanceOf(S3BlobStoreError);

    const malformedChunk = new MockS3Client();
    malformedChunk.responses.push({
      Body: Readable.from([{ not: "bytes" }], { objectMode: true }),
    });
    await expect(store(malformedChunk).get("opaque-key")).rejects.toBeInstanceOf(S3BlobStoreError);

    const truncated = new MockS3Client();
    truncated.responses.push({ Body: Uint8Array.from([1]), ContentLength: 2 });
    await expect(store(truncated).get("opaque-key")).rejects.toBeInstanceOf(S3BlobStoreError);

    const invalidLength = new MockS3Client();
    invalidLength.responses.push({ Body: Uint8Array.from([1]), ContentLength: Number.NaN });
    await expect(store(invalidLength).get("opaque-key")).rejects.toBeInstanceOf(S3BlobStoreError);
  });

  it("maps missing objects and keeps provider failures credential-safe", async () => {
    const missing = new MockS3Client();
    const notFound = new Error("not found");
    notFound.name = "NoSuchKey";
    missing.responses.push(notFound);
    await expect(store(missing).get("opaque-key")).rejects.toBeInstanceOf(S3BlobNotFoundError);

    const failed = new MockS3Client();
    failed.responses.push(new Error("https://ACCESS:SECRET@account.r2.cloudflarestorage.com"));
    const error = await store(failed)
      .get("opaque-key")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(S3BlobStoreError);
    expect(String(error)).not.toContain("ACCESS");
    expect(String(error)).not.toContain("SECRET");
    expect(error).not.toHaveProperty("cause");

    const failedStream = new MockS3Client();
    const stream = new Readable({
      read() {
        this.destroy(new Error("stream failed at https://ACCESS:SECRET@example.test"));
      },
    });
    failedStream.responses.push({ Body: stream });
    const streamError = await store(failedStream)
      .get("opaque-key")
      .catch((caught: unknown) => caught);
    expect(streamError).toBeInstanceOf(S3BlobStoreError);
    expect(String(streamError)).not.toContain("ACCESS");
    expect(String(streamError)).not.toContain("SECRET");
  });

  it("deletes idempotently and passes the opaque key unchanged", async () => {
    const client = new MockS3Client();
    const missing = new Error("missing");
    Object.assign(missing, { $metadata: { httpStatusCode: 404 } });
    client.responses.push({}, missing);
    const blobs = store(client);

    await blobs.delete("first/opaque-key");
    await blobs.delete("already-gone");

    expect(client.commands).toHaveLength(2);
    expect(client.commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(client.commands[0]?.input).toEqual({
      Bucket: "private-raise-blobs",
      Key: "first/opaque-key",
    });
  });

  it("destroys its client once and rejects later operations", async () => {
    const client = new MockS3Client();
    const blobs = store(client);

    await blobs.close();
    await blobs.close();

    expect(client.destroyCalls).toBe(1);
    await expect(blobs.get("opaque-key")).rejects.toThrow("closed");
    expect(client.commands).toHaveLength(0);
  });
});
