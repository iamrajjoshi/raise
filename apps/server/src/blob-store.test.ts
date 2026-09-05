import { access, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBlobStore } from "./blob-store.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((remove) => remove()));
});

class PausedStartupBlobStore extends LocalBlobStore {
  readonly startupSweepBegan: Promise<void>;
  sweepCount = 0;
  private finishStartupSweep!: () => void;
  private signalStartupSweep!: () => void;

  constructor(root: string) {
    super(root, { sweepIntervalMs: 1 });
    this.startupSweepBegan = new Promise((resolve) => {
      this.signalStartupSweep = resolve;
    });
  }

  override sweepExpired(): Promise<number> {
    this.sweepCount += 1;
    if (this.sweepCount > 1) return Promise.resolve(0);
    this.signalStartupSweep();
    return new Promise((resolve) => {
      this.finishStartupSweep = () => resolve(0);
    });
  }

  releaseStartupSweep(): void {
    this.finishStartupSweep();
  }
}

describe("LocalBlobStore", () => {
  it("writes opaque keys, reads exact bytes, and deletes idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-blobs-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new LocalBlobStore(directory);
    const bytes = Buffer.from("private screenshot bytes");

    const key = "ephemeral/v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await store.put({
      key,
      bytes,
    });

    await expect(store.get(key)).resolves.toEqual(bytes);
    expect((await stat(join(directory, key))).mode & 0o777).toBe(0o600);
    await store.delete(key);
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects relative and absolute paths outside its root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-blobs-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new LocalBlobStore(directory);

    await expect(store.get("../outside")).rejects.toThrow("valid opaque");
    await expect(store.get("/tmp/outside")).rejects.toThrow("valid opaque");
    await expect(store.get("ephemeral/v1/short")).rejects.toThrow("valid opaque");
  });

  it("removes only expired Raise objects during the awaited startup sweep", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-blobs-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const oldKey = `ephemeral/v1/${"A".repeat(43)}`;
    const freshKey = `ephemeral/v1/${"B".repeat(43)}`;
    const writer = new LocalBlobStore(directory, { sweepIntervalMs: 0 });
    await writer.put({ key: oldKey, bytes: Buffer.from("old ciphertext") });
    await writer.put({ key: freshKey, bytes: Buffer.from("fresh ciphertext") });
    await utimes(join(directory, oldKey), new Date(now - 1_001), new Date(now - 1_001));
    await utimes(join(directory, freshKey), new Date(now - 999), new Date(now - 999));
    const ignoredPath = join(directory, "ephemeral", "v1", "operator-note");
    await writeFile(ignoredPath, "not a Raise object");
    await utimes(ignoredPath, new Date(now - 10_000), new Date(now - 10_000));

    const store = new LocalBlobStore(directory, {
      maxAgeMs: 1_000,
      sweepIntervalMs: 0,
      now: () => now,
    });
    await store.start();

    await expect(access(join(directory, oldKey))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.get(freshKey)).resolves.toEqual(Buffer.from("fresh ciphertext"));
    await expect(access(ignoredPath)).resolves.toBeUndefined();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await store.close();
  });

  it("ignores directories and symlinks during cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-blobs-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const objectDirectory = join(directory, "ephemeral", "v1");
    await mkdir(join(objectDirectory, "C".repeat(43)), { recursive: true });
    const outside = join(directory, "outside");
    const link = join(objectDirectory, "D".repeat(43));
    await writeFile(outside, "outside");
    await symlink(outside, link);
    const store = new LocalBlobStore(directory, {
      maxAgeMs: 1,
      sweepIntervalMs: 0,
      now: () => Date.now() + 10_000,
    });

    await expect(store.sweepExpired()).resolves.toBe(0);
    await expect(access(join(objectDirectory, "C".repeat(43)))).resolves.toBeUndefined();
    await expect(access(link)).resolves.toBeUndefined();
    await expect(access(outside)).resolves.toBeUndefined();
  });

  it("does not leave a cleanup timer when closed during startup", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "raise-blobs-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PausedStartupBlobStore(directory);
    const starting = store.start();
    await store.startupSweepBegan;

    const closing = store.close();
    store.releaseStartupSweep();
    await Promise.all([starting, closing]);
    await vi.advanceTimersByTimeAsync(10);

    expect(store.sweepCount).toBe(1);
    await expect(store.start()).rejects.toThrow("closed");
  });
});
