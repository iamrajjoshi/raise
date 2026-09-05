import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RaiseStore } from "./storage.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectValkeyRaiseStore: vi.fn(),
}));

vi.mock("./valkey-store.js", () => ({
  connectValkeyRaiseStore: mocks.connectValkeyRaiseStore,
}));
import { createRuntimeApp, reportValkeyConnectionError } from "./runtime.js";

function closeOnlyRaiseStore(close: RaiseStore["close"]): RaiseStore {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error("Unexpected Raise store operation.");
  };
  return {
    createRaise: unexpectedOperation,
    inspectClaim: unexpectedOperation,
    commitClaimExchange: unexpectedOperation,
    getRaise: unexpectedOperation,
    preflightAppend: unexpectedOperation,
    appendEntry: unexpectedOperation,
    getAttachment: unexpectedOperation,
    close,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.connectValkeyRaiseStore.mockReset();
});

describe("createRuntimeApp", () => {
  it("uses Valkey with the local blob store", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-runtime-valkey-"));
    const close = vi.fn(async () => undefined);
    const store = closeOnlyRaiseStore(close);
    mocks.connectValkeyRaiseStore.mockResolvedValue(store);
    const app = await createRuntimeApp({
      dataDir: root,
      publicBaseUrl: "http://raise.test",
      valkeyUrl: "rediss://user:secret@valkey.example:6379",
      blob: { driver: "local" },
    });

    try {
      expect(mocks.connectValkeyRaiseStore).toHaveBeenCalledWith({
        url: "rediss://user:secret@valkey.example:6379",
        onError: reportValkeyConnectionError,
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses an S3-compatible blob store without touching local storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-runtime-s3-"));
    const raiseClose = vi.fn(async () => undefined);
    mocks.connectValkeyRaiseStore.mockResolvedValue(closeOnlyRaiseStore(raiseClose));
    const clientConfig = {
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    };
    const app = await createRuntimeApp({
      dataDir: root,
      publicBaseUrl: "https://raise.test",
      valkeyUrl: "rediss://valkey.example:6379",
      blob: {
        driver: "s3",
        bucket: "private-raise-blobs",
        clientConfig,
      },
    });

    try {
      await expect(access(join(root, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(raiseClose).toHaveBeenCalledOnce();
  });
});

describe("reportValkeyConnectionError", () => {
  it("does not print credentials from a connection error", () => {
    const error = new Error("connect failed: rediss://user:secret@valkey.example:6379");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportValkeyConnectionError(error);

    expect(consoleError).toHaveBeenCalledWith("Valkey connection failed.");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");
  });
});
