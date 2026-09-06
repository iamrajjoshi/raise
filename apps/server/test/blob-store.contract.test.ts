import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, type DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../src/blob-store.js";
import { S3BlobStore, type S3BlobCommandClient } from "../src/s3-blob-store.js";
import type { BlobStore } from "../src/storage.js";

const FIRST_KEY = `ephemeral/v1/${"A".repeat(43)}`;
const SECOND_KEY = `ephemeral/v1/${"B".repeat(43)}`;

interface BlobStoreFixture {
  store: BlobStore;
  cleanup(): Promise<void>;
}

type BlobStoreFactory = () => Promise<BlobStoreFixture>;

class MemoryS3Client implements S3BlobCommandClient {
  readonly objects = new Map<string, Buffer>();

  async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
    const key = command.input.Key;
    if (!key) throw new Error("A test object key is required.");

    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch === "*" && this.objects.has(key)) {
        const error = new Error("Object already exists.");
        error.name = "PreconditionFailed";
        throw error;
      }
      if (!(command.input.Body instanceof Uint8Array)) {
        throw new Error("The test client only accepts byte-array bodies.");
      }
      this.objects.set(key, Buffer.from(command.input.Body));
      return {};
    }

    if (command instanceof GetObjectCommand) {
      const value = this.objects.get(key);
      if (!value) {
        const error = new Error("Object not found.");
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: Buffer.from(value), ContentLength: value.byteLength };
    }

    this.objects.delete(key);
    return {};
  }
}

function blobStoreContract(name: string, createFixture: BlobStoreFactory): void {
  describe(`${name} BlobStore contract`, () => {
    let fixture: BlobStoreFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    it("round-trips opaque binary objects without sharing caller memory", async () => {
      const source = Buffer.from([0, 1, 2, 255]);
      await fixture.store.put({ key: FIRST_KEY, bytes: source });
      source.fill(9);

      const firstRead = await fixture.store.get(FIRST_KEY);
      expect(firstRead).toEqual(Buffer.from([0, 1, 2, 255]));
      firstRead.fill(8);
      await expect(fixture.store.get(FIRST_KEY)).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
    });

    it("does not overwrite an existing opaque object", async () => {
      await fixture.store.put({ key: FIRST_KEY, bytes: Buffer.from("first") });

      await expect(
        fixture.store.put({ key: FIRST_KEY, bytes: Buffer.from("second") }),
      ).rejects.toBeInstanceOf(Error);
      await expect(fixture.store.get(FIRST_KEY)).resolves.toEqual(Buffer.from("first"));
    });

    it("deletes idempotently without affecting other objects", async () => {
      await fixture.store.put({ key: FIRST_KEY, bytes: Buffer.from("first") });
      await fixture.store.put({ key: SECOND_KEY, bytes: Buffer.from("second") });

      await fixture.store.delete(FIRST_KEY);
      await fixture.store.delete(FIRST_KEY);

      await expect(fixture.store.get(FIRST_KEY)).rejects.toBeInstanceOf(Error);
      await expect(fixture.store.get(SECOND_KEY)).resolves.toEqual(Buffer.from("second"));
    });
  });
}

blobStoreContract("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "raise-blob-contract-"));
  const store = new LocalBlobStore(root, { sweepIntervalMs: 0 });
  await store.start();
  return {
    store,
    async cleanup() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
});

blobStoreContract("S3-compatible", async () => {
  const store = new S3BlobStore({
    bucket: "private-raise-blobs",
    client: new MemoryS3Client(),
  });
  return {
    store,
    async cleanup() {
      await store.close();
    },
  };
});
