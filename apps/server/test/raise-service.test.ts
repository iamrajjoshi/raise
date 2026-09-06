import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RaiseService } from "../src/raise-service.js";
import { RAISE_HARD_TTL_MS, RetentionBudgetExhaustedError } from "../src/retention.js";
import {
  StoreCommitOutcomeUnknownError,
  type AppendEntryCommand,
  type BlobStore,
  type BlobWrite,
  type RaiseStore,
} from "../src/storage.js";
import { valkeyRaiseKeys } from "../src/valkey-store.js";
import {
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void>> = [];
let testServer: ValkeyTestServer;

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  reads = 0;
  writes = 0;

  constructor(private readonly failOnWrite?: number) {}

  async put(input: BlobWrite) {
    this.writes += 1;
    if (this.writes === this.failOnWrite) throw new Error("injected blob failure");
    this.values.set(input.key, input.bytes);
  }

  async get(key: string) {
    this.reads += 1;
    const value = this.values.get(key);
    if (!value) throw new Error("missing test blob");
    return value;
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.values.delete(key);
  }

  async close() {}
}

beforeAll(async () => {
  testServer = await startValkeyTestServer();
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

afterAll(async () => {
  await testServer.stop();
});

function storeWithOverrides(store: RaiseStore, overrides: Partial<RaiseStore>): RaiseStore {
  return {
    createRaise: (command) => overrides.createRaise?.(command) ?? store.createRaise(command),
    inspectClaim: (command) => overrides.inspectClaim?.(command) ?? store.inspectClaim(command),
    commitClaimExchange: (command) =>
      overrides.commitClaimExchange?.(command) ?? store.commitClaimExchange(command),
    getRaise: (raiseId, session, options) =>
      overrides.getRaise?.(raiseId, session, options) ?? store.getRaise(raiseId, session, options),
    preflightAppend: (command) =>
      overrides.preflightAppend?.(command) ?? store.preflightAppend(command),
    appendEntry: (command) => overrides.appendEntry?.(command) ?? store.appendEntry(command),
    getAttachment: (raiseId, attachmentId, session) =>
      overrides.getAttachment?.(raiseId, attachmentId, session) ??
      store.getAttachment(raiseId, attachmentId, session),
    close: () => overrides.close?.() ?? store.close(),
  };
}

async function setup(
  blobStore = new MemoryBlobStore(),
  decorateStore: (store: RaiseStore) => RaiseStore = (store) => store,
) {
  const valkey = await createValkeyTestStore(testServer.url, "raise-service");
  cleanups.push(valkey.cleanup);
  const raises = decorateStore(valkey.store);
  const service = new RaiseService(raises, blobStore, () => "http://raise.test");
  return { blobStore, service, valkey };
}

async function storedKeys(valkey: Awaited<ReturnType<typeof createValkeyTestStore>>) {
  const keys: string[] = [];
  for await (const batch of valkey.client.scanIterator({
    MATCH: `${valkey.keyPrefix}*`,
    COUNT: 100,
  })) {
    keys.push(...batch);
  }
  return keys;
}

function storeWithUnknownAppendOutcome(store: RaiseStore): RaiseStore {
  return storeWithOverrides(store, {
    async appendEntry(command: AppendEntryCommand) {
      await store.appendEntry(command);
      throw new StoreCommitOutcomeUnknownError("injected lost commit response");
    },
  });
}

function storeWithSessionRetention(store: RaiseStore, sessionExpiresAt: string): RaiseStore {
  return storeWithOverrides(store, {
    inspectClaim: async (command) => ({
      ...(await store.inspectClaim(command)),
      sessionExpiresAt,
    }),
    commitClaimExchange: async (command) => ({
      ...(await store.commitClaimExchange(command)),
      sessionExpiresAt,
    }),
  });
}

function attachment(name: string) {
  return { name, mimeType: "image/png" as const, dataUrl: onePixelPng };
}

function claimToken(url: string) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("token") as string;
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => resolve();
  });
  return { promise, resolve: resolvePromise };
}

describe("RaiseService attachment commits", () => {
  it("removes staged blobs without committing state when creation exhausts its hard lifetime", async () => {
    const valkey = await createValkeyTestStore(testServer.url, "expired-create");
    cleanups.push(valkey.cleanup);
    const blobs = new MemoryBlobStore();
    let monotonicNow = 0;
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (input) => {
      await originalPut(input);
      monotonicNow = RAISE_HARD_TTL_MS + 1;
    };
    const service = new RaiseService(
      valkey.store,
      blobs,
      () => "http://raise.test",
      () => monotonicNow,
    );

    await expect(
      service.createRaise({
        origin: "human",
        prompt: "This upload took too long.",
        attachments: [attachment("slow.png")],
      }),
    ).rejects.toBeInstanceOf(RetentionBudgetExhaustedError);

    expect(blobs.values.size).toBe(0);
    expect(blobs.deleted).toHaveLength(1);
    expect(await storedKeys(valkey)).toEqual([]);
  });

  it("removes earlier staged blobs when a later write fails", async () => {
    const blobs = new MemoryBlobStore(2);
    const { service, valkey } = await setup(blobs);

    await expect(
      service.createRaise({
        origin: "human",
        prompt: "Compare these screenshots.",
        attachments: [attachment("first.png"), attachment("second.png")],
      }),
    ).rejects.toThrow("injected blob failure");

    expect(blobs.values.size).toBe(0);
    expect(blobs.deleted).toHaveLength(2);
    expect(blobs.deleted).toEqual([
      expect.stringMatching(/^ephemeral\/v1\/[A-Za-z0-9_-]{43}$/),
      expect.stringMatching(/^ephemeral\/v1\/[A-Za-z0-9_-]{43}$/),
    ]);
    expect(await storedKeys(valkey)).toEqual([]);
  });

  it("removes the attempted key when a blob write succeeds before its response fails", async () => {
    const blobs = new MemoryBlobStore();
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (input) => {
      await originalPut(input);
      throw new Error("injected lost blob response");
    };
    const { service, valkey } = await setup(blobs);

    await expect(
      service.createRaise({
        origin: "human",
        prompt: "Store this screenshot.",
        attachments: [attachment("uncertain.png")],
      }),
    ).rejects.toThrow("injected lost blob response");

    expect(blobs.values.size).toBe(0);
    expect(blobs.deleted).toHaveLength(1);
    expect(await storedKeys(valkey)).toEqual([]);
  });

  it("removes all staged blobs when the create commit fails", async () => {
    const { blobStore, service, valkey } = await setup(new MemoryBlobStore(), (store) =>
      storeWithOverrides(store, {
        async createRaise() {
          throw new Error("injected create failure");
        },
      }),
    );

    await expect(
      service.createRaise({
        origin: "human",
        prompt: "This should roll back.",
        attachments: [attachment("first.png"), attachment("second.png")],
      }),
    ).rejects.toThrow("injected create failure");

    expect(await storedKeys(valkey)).toEqual([]);
    expect(blobStore.values.size).toBe(0);
    expect(blobStore.deleted).toHaveLength(2);
  });

  it("keeps the prior turn intact when an append commit fails", async () => {
    const { blobStore, service } = await setup(new MemoryBlobStore(), (store) =>
      storeWithOverrides(store, {
        async appendEntry() {
          throw new Error("injected append failure");
        },
      }),
    );
    const created = await service.createRaise({
      origin: "human",
      prompt: "Fix the mobile header.",
      attachments: [],
    });
    const claimed = await service.exchangeClaim(
      created.raiseId,
      claimToken(created.targetClaimUrl),
      "token",
      "agent",
    );

    await expect(
      service.postEntry(
        created.raiseId,
        claimed.sessionToken,
        {
          kind: "result",
          body: "Fixed it.",
          attachments: [attachment("result.png")],
          expectedVersion: 1,
        },
        "metadata-failure-0001",
      ),
    ).rejects.toThrow("injected append failure");

    const view = await service.getRaise(created.raiseId, claimed.sessionToken);
    expect(view).toMatchObject({ version: 1, waitingOn: "agent", pendingAction: "perform_work" });
    expect(view.entries).toHaveLength(1);
    expect(blobStore.values.size).toBe(0);
  });

  it("removes a staged blob when another writer wins during upload", async () => {
    const uploadStarted = deferred();
    const uploadRelease = deferred();
    const blobs = new MemoryBlobStore();
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (input) => {
      uploadStarted.resolve();
      await uploadRelease.promise;
      await originalPut(input);
    };
    const { service } = await setup(blobs);
    const created = await service.createRaise({
      origin: "human",
      prompt: "Fix the header.",
      attachments: [],
    });
    const agent = await service.exchangeClaim(
      created.raiseId,
      claimToken(created.targetClaimUrl),
      "token",
      "agent",
    );

    const losingWrite = service.postEntry(
      created.raiseId,
      agent.sessionToken,
      {
        kind: "result",
        body: "Losing result.",
        attachments: [attachment("loser.png")],
        expectedVersion: 1,
      },
      "losing-write-0001",
    );
    await uploadStarted.promise;
    await service.postEntry(
      created.raiseId,
      agent.sessionToken,
      {
        kind: "result",
        body: "Winning result.",
        expectedVersion: 1,
        attachments: [],
      },
      "winning-write-0001",
    );
    uploadRelease.resolve();

    await expect(losingWrite).rejects.toMatchObject({ code: "state_conflict" });
    const view = await service.getRaise(created.raiseId, agent.sessionToken);
    expect(view.version).toBe(2);
    expect(view.entries.map((entry) => entry.id)).toEqual([
      expect.stringMatching(/^e_/),
      expect.stringMatching(/^e_/),
    ]);
    expect(blobs.values.size).toBe(0);
    expect(blobs.deleted).toHaveLength(1);
  });

  it("removes the losing staged blob when identical idempotent appends race", async () => {
    const bothUploaded = deferred();
    const blobs = new MemoryBlobStore();
    const originalPut = blobs.put.bind(blobs);
    let uploadCount = 0;
    blobs.put = async (input) => {
      await originalPut(input);
      uploadCount += 1;
      if (uploadCount === 2) bothUploaded.resolve();
      await bothUploaded.promise;
    };
    const { service } = await setup(blobs);
    const created = await service.createRaise({
      origin: "human",
      prompt: "Fix the header.",
      attachments: [],
    });
    const agent = await service.exchangeClaim(
      created.raiseId,
      claimToken(created.targetClaimUrl),
      "token",
      "agent",
    );
    const input = {
      kind: "result" as const,
      body: "Same result.",
      attachments: [attachment("same.png")],
      expectedVersion: 1,
    };

    const results = await Promise.all([
      service.postEntry(created.raiseId, agent.sessionToken, input, "shared-race-key-0001"),
      service.postEntry(created.raiseId, agent.sessionToken, input, "shared-race-key-0001"),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.version).toBe(2);
    expect(results[1]?.version).toBe(2);
    expect(blobs.writes).toBe(2);
    expect(blobs.values.size).toBe(1);
    expect(blobs.deleted).toHaveLength(1);
    const view = await service.getRaise(created.raiseId, agent.sessionToken);
    expect(view.entries).toHaveLength(2);
    expect(view.entries.at(-1)?.attachments).toHaveLength(1);
  });

  it("keeps referenced blobs when a store commit outcome is unknown", async () => {
    const blobs = new MemoryBlobStore();
    const { service, valkey } = await setup(blobs, storeWithUnknownAppendOutcome);
    const created = await service.createRaise({
      origin: "human",
      prompt: "Fix the header.",
      attachments: [],
    });
    const agent = await service.exchangeClaim(
      created.raiseId,
      claimToken(created.targetClaimUrl),
      "token",
      "agent",
    );

    const input = {
      kind: "result" as const,
      body: "Committed before the response was lost.",
      attachments: [attachment("committed.png")],
      expectedVersion: 1,
    };
    await expect(
      service.postEntry(created.raiseId, agent.sessionToken, input, "unknown-outcome-0001"),
    ).rejects.toBeInstanceOf(StoreCommitOutcomeUnknownError);

    const view = await service.getRaise(created.raiseId, agent.sessionToken);
    expect(view).toMatchObject({ version: 2, waitingOn: "human", pendingAction: "review_result" });
    expect(view.entries.at(-1)?.attachments).toHaveLength(1);
    expect(blobs.values.size).toBe(1);
    expect(blobs.deleted).toHaveLength(0);
    const idempotencyKey = valkeyRaiseKeys(created.raiseId, valkey.keyPrefix).idempotency;
    const persisted = Object.entries(await valkey.client.hGetAll(idempotencyKey)).filter(
      ([field]) => field !== "__schema",
    );
    expect(persisted).toHaveLength(1);
    const [keyDigest, receiptJson] = persisted[0]!;
    const receipt = JSON.parse(receiptJson) as { requestDigest: string };
    expect(keyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(keyDigest).not.toBe(createHash("sha256").update("unknown-outcome-0001").digest("hex"));
    expect(receiptJson).not.toContain(input.body);

    const semanticallyIdenticalInput = {
      ...input,
      attachments: input.attachments.map((item) => ({
        ...item,
        dataUrl: item.dataUrl.replace("base64,", "base64,\n"),
      })),
    };
    await expect(
      service.postEntry(
        created.raiseId,
        agent.sessionToken,
        semanticallyIdenticalInput,
        "unknown-outcome-0001",
      ),
    ).resolves.toMatchObject({ version: 2 });
    expect(blobs.writes).toBe(1);
    expect(blobs.deleted).toHaveLength(0);
    await expect(
      service.postEntry(
        created.raiseId,
        agent.sessionToken,
        { ...input, body: "A different result." },
        "unknown-outcome-0001",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(blobs.writes).toBe(1);
  });

  it("does not read a blob before attachment authorization succeeds", async () => {
    const { blobStore, service } = await setup();
    const first = await service.createRaise({
      origin: "human",
      prompt: "First request.",
      attachments: [attachment("first.png")],
    });
    const second = await service.createRaise({
      origin: "human",
      prompt: "Second request.",
      attachments: [],
    });
    const firstHuman = await service.exchangeClaim(
      first.raiseId,
      claimToken(first.ownerClaimUrl),
      "token",
      "human",
    );
    const secondHuman = await service.exchangeClaim(
      second.raiseId,
      claimToken(second.ownerClaimUrl),
      "token",
      "human",
    );
    const firstView = await service.getRaise(first.raiseId, firstHuman.sessionToken);
    const attachmentId = firstView.entries[0]?.attachments[0]?.id as string;

    await expect(
      service.getAttachment(first.raiseId, attachmentId, secondHuman.sessionToken),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(blobStore.reads).toBe(0);
  });
});

describe("RaiseService session retention", () => {
  it("returns the hard credential deadline for new and replayed claim exchanges", async () => {
    const sessionExpiresAt = "2099-01-02T00:00:00.000Z";
    const { service } = await setup(new MemoryBlobStore(), (store) =>
      storeWithSessionRetention(store, sessionExpiresAt),
    );
    const created = await service.createRaise({
      origin: "human",
      prompt: "Keep the peer credential through the hard deadline.",
      attachments: [],
    });
    const token = claimToken(created.targetClaimUrl);
    const exchangeId = "session-retention-replay";

    const first = await service.exchangeClaim(created.raiseId, token, "token", "agent", exchangeId);
    const replay = await service.exchangeClaim(
      created.raiseId,
      token,
      "token",
      "agent",
      exchangeId,
    );

    expect(first.expiresAt).toBe(sessionExpiresAt);
    expect(replay.expiresAt).toBe(sessionExpiresAt);
  });
});
