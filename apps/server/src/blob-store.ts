import { chmod, lstat, mkdir, opendir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RAISE_HARD_TTL_MS } from "./retention.js";
import { BLOB_KEY_PREFIX, type BlobStore, type BlobWrite } from "./storage.js";

const LOCAL_BLOB_SWEEP_INTERVAL_MS = 30 * 60 * 1_000;

const BLOB_NAME = /^[A-Za-z0-9_-]{43}$/;

export interface LocalBlobStoreOptions {
  maxAgeMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  onSweepError?: (error: Error) => void;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class LocalBlobStore implements BlobStore {
  private readonly root: string;
  private readonly maxAgeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly onSweepError: (error: Error) => void;
  private startPromise?: Promise<void>;
  private sweepPromise: Promise<number> | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(root: string, options: LocalBlobStoreOptions = {}) {
    this.root = resolve(root);
    this.maxAgeMs = options.maxAgeMs ?? RAISE_HARD_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? LOCAL_BLOB_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onSweepError = options.onSweepError ?? (() => console.error("Local blob cleanup failed."));
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new Error("Local blob maximum age must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.sweepIntervalMs) || this.sweepIntervalMs < 0) {
      throw new Error("Local blob sweep interval must be a non-negative integer.");
    }
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The local blob store is closed."));
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  async put(input: BlobWrite): Promise<void> {
    const path = this.resolveKey(input.key);
    await this.ensurePrivateDirectory(dirname(path));
    await writeFile(path, input.bytes, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearSweepTimer();
    await this.startPromise;
    this.clearSweepTimer();
    await this.sweepPromise;
  }

  sweepExpired(): Promise<number> {
    this.sweepPromise ??= this.sweepOnce().finally(() => {
      this.sweepPromise = undefined;
    });
    return this.sweepPromise;
  }

  private resolveKey(key: string): string {
    const name = key.startsWith(BLOB_KEY_PREFIX) ? key.slice(BLOB_KEY_PREFIX.length) : "";
    if (!BLOB_NAME.test(name)) {
      throw new Error("Blob key is not a valid opaque Raise object key.");
    }
    return join(this.root, key);
  }

  private async startInternal(): Promise<void> {
    await this.ensurePrivateDirectory(this.root);
    await this.sweepExpired();
    if (!this.closed && this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweepExpired().catch((error: unknown) => {
          this.onSweepError(error instanceof Error ? error : new Error("Blob cleanup failed."));
        });
      }, this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  private clearSweepTimer(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }

  private async sweepOnce(): Promise<number> {
    const directory = join(this.root, BLOB_KEY_PREFIX);
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }

    const cutoff = this.now() - this.maxAgeMs;
    let removed = 0;
    for await (const entry of entries) {
      if (!entry.isFile() || !BLOB_NAME.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.mtimeMs > cutoff) continue;
        await unlink(path);
        removed += 1;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return removed;
  }
}
