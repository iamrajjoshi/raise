import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pendingMutationDigest,
  pendingOpenDigest,
  PendingExchangeStore,
  PendingMutationStore,
  PendingOpenStore,
  SessionStore,
} from "./store.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP session store", () => {
  it("keeps concurrent server-scoped sessions in separate private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const first = new SessionStore(directory);
    const second = new SessionStore(directory);
    await Promise.all([
      first.put({
        server: "https://raise.example",
        raiseId: "r_one",
        role: "agent",
        token: "ses_one.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      second.put({
        server: "https://other.example",
        raiseId: "r_two",
        role: "agent",
        token: "ses_two.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);

    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    await Promise.all(
      files.map(async (file) =>
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600),
      ),
    );
    const fresh = new SessionStore(directory);
    await expect(fresh.get("https://raise.example", "r_one")).resolves.toMatchObject({
      token: "ses_one.secret",
    });
    await expect(fresh.get("https://other.example", "r_two")).resolves.toMatchObject({
      token: "ses_two.secret",
    });
  });

  it("removes expired credentials and retains an in-memory recovery copy if disk writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const store = new SessionStore(directory);
    await store.put({
      server: "https://raise.example",
      raiseId: "r_old",
      role: "agent",
      token: "ses_old.secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(store.get("https://raise.example", "r_old")).rejects.toThrow("expired");
    expect((await readdir(directory)).length).toBe(0);

    const blockedPath = join(root, "not-a-directory");
    await writeFile(blockedPath, "blocked");
    const memoryOnly = new SessionStore(blockedPath);
    const session = {
      server: "https://raise.example",
      raiseId: "r_memory",
      role: "agent" as const,
      token: "ses_memory.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await expect(memoryOnly.put(session)).resolves.toBe(false);
    await expect(memoryOnly.get(session.server, session.raiseId)).resolves.toEqual(session);
    expect(await readFile(blockedPath, "utf8")).toBe("blocked");
  });

  it("rejects malformed persisted sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const session = {
      server: "https://raise.example",
      raiseId: "r_invalid",
      role: "agent" as const,
      token: "ses_invalid.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await new SessionStore(directory).put(session);
    const [sessionFile] = await readdir(directory);
    if (!sessionFile) throw new Error("Expected a persisted session file.");
    await writeFile(join(directory, sessionFile), JSON.stringify({ ...session, role: "admin" }));

    await expect(new SessionStore(directory).get(session.server, session.raiseId)).rejects.toThrow(
      "invalid",
    );
  });

  it("removes a token-bearing temporary file when a session replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const store = new SessionStore(directory);
    const session = {
      server: "https://raise.example",
      raiseId: "r_cleanup",
      role: "agent" as const,
      token: "ses_cleanup.private-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    await expect(store.put(session)).resolves.toBe(true);
    const [sessionFile] = await readdir(directory);
    if (!sessionFile) throw new Error("Expected the initial session file.");
    const sessionPath = join(directory, sessionFile);
    await rm(sessionPath);
    await mkdir(sessionPath);

    await expect(store.put({ ...session, token: "ses_cleanup.replacement-secret" })).resolves.toBe(
      false,
    );
    expect(await readdir(directory)).toEqual([sessionFile]);
    expect(await readdir(sessionPath)).toEqual([]);
  });

  it("persists random claim retry IDs without storing claim secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const claimToken = "cap_owner.a-very-private-claim-secret";
    const first = new PendingExchangeStore(directory);

    const exchangeId = await first.getOrCreate("https://raise.example", claimToken);
    expect(exchangeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const restarted = new PendingExchangeStore(directory);
    await expect(restarted.getOrCreate("https://raise.example", claimToken)).resolves.toBe(
      exchangeId,
    );

    const pendingFiles = (await readdir(directory)).filter((file) =>
      file.startsWith("pending-exchange-"),
    );
    expect(pendingFiles).toHaveLength(1);
    const path = join(directory, pendingFiles[0]!);
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(claimToken);
    expect(contents).toContain(exchangeId);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await restarted.clear("https://raise.example", claimToken);
    const replacement = await new PendingExchangeStore(directory).getOrCreate(
      "https://raise.example",
      claimToken,
    );
    expect(replacement).not.toBe(exchangeId);
  });

  it("atomically shares one exchange ID across concurrent store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");

    const exchangeIds = await Promise.all(
      Array.from({ length: 12 }, () =>
        new PendingExchangeStore(directory).getOrCreate(
          "https://raise.example",
          "cap_owner.one-concurrent-private-secret",
        ),
      ),
    );

    expect(new Set(exchangeIds).size).toBe(1);
    expect(
      (await readdir(directory)).filter((file) => file.startsWith("pending-exchange-")),
    ).toHaveLength(1);
  });

  it("expires stale pending exchanges", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    let timestamp = Date.parse("2026-09-02T00:00:00.000Z");
    const store = new PendingExchangeStore(directory, {
      now: () => new Date(timestamp),
      ttlMs: 1_000,
    });
    const token = "cap_owner.expiring-private-secret";
    const first = await store.getOrCreate("https://raise.example", token);

    timestamp += 1_001;
    const replacement = await store.getOrCreate("https://raise.example", token);

    expect(replacement).not.toBe(first);
  });

  it("persists an exact mutation retry without storing content or credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const session = {
      server: "https://raise.example",
      raiseId: "r_mutation",
      role: "agent" as const,
      token: "ses_agent.a-private-bearer-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const privateBody = "The private answer belongs only in the request.";
    const privateUrl = "https://private.example/design?draft=secret";
    const privateImage = "data:image/png;base64,cHJpdmF0ZS1pbWFnZS1ieXRlcw==";
    const inputDigest = pendingMutationDigest({
      kind: "result",
      body: privateBody,
      url: privateUrl,
      attachments: [
        {
          name: "private-design.png",
          mimeType: "image/png",
          dataUrl: privateImage,
        },
      ],
      expectedVersion: 3,
    });
    const first = new PendingMutationStore(directory);

    const pending = await first.getOrCreate(session, inputDigest, 3);
    expect(pending).toMatchObject({ expectedVersion: 3, resumed: false });
    expect(pending.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

    await expect(
      new PendingMutationStore(directory).getOrCreate(session, inputDigest, 3),
    ).resolves.toEqual({ ...pending, resumed: true });

    const files = (await readdir(directory)).filter((file) => file.startsWith("pending-mutation-"));
    expect(files).toHaveLength(1);
    const path = join(directory, files[0]!);
    const contents = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(contents) as object).sort()).toEqual([
      "createdAt",
      "expectedVersion",
      "idempotencyKey",
      "inputDigest",
      "raiseId",
      "server",
      "sessionDigest",
    ]);
    expect(contents).toContain(pending.idempotencyKey);
    expect(contents).toContain(inputDigest);
    expect(contents).not.toContain(session.token);
    expect(contents).not.toContain(privateBody);
    expect(contents).not.toContain(privateUrl);
    expect(contents).not.toContain("private-design.png");
    expect(contents).not.toContain(privateImage);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("uses new mutation keys for different content, versions, and sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const session = {
      server: "https://raise.example",
      raiseId: "r_mutation",
      role: "agent" as const,
      token: "ses_agent.first-private-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const firstDigest = pendingMutationDigest({
      kind: "comment",
      body: "First note",
      attachments: [],
      expectedVersion: 3,
    });
    const secondDigest = pendingMutationDigest({
      kind: "comment",
      body: "Different note",
      attachments: [],
      expectedVersion: 3,
    });
    const store = new PendingMutationStore(directory);

    const first = await store.getOrCreate(session, firstDigest, 3);
    const changedContent = await store.getOrCreate(session, secondDigest, 3);
    const changedVersion = await store.getOrCreate(session, firstDigest, 4);
    const changedSession = await store.getOrCreate(
      { ...session, token: "ses_agent.second-private-token" },
      firstDigest,
      3,
    );

    expect(
      new Set([
        first.idempotencyKey,
        changedContent.idempotencyKey,
        changedVersion.idempotencyKey,
        changedSession.idempotencyKey,
      ]).size,
    ).toBe(4);
  });

  it("shares one mutation key concurrently, clears it, and expires stale records", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    let timestamp = Date.parse("2026-09-02T00:00:00.000Z");
    const session = {
      server: "https://raise.example",
      raiseId: "r_mutation",
      role: "agent" as const,
      token: "ses_agent.concurrent-private-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const digest = pendingMutationDigest({
      kind: "comment",
      body: "One concurrent operation",
      attachments: [],
      expectedVersion: 2,
    });
    const stores = Array.from(
      { length: 12 },
      () =>
        new PendingMutationStore(directory, {
          now: () => new Date(timestamp),
          ttlMs: 1_000,
        }),
    );

    const concurrent = await Promise.all(
      stores.map((store) => store.getOrCreate(session, digest, 2)),
    );
    expect(new Set(concurrent.map((record) => record.idempotencyKey)).size).toBe(1);

    const originalKey = concurrent[0]!.idempotencyKey;
    await stores[0]!.clear(session, digest, 2);
    const afterClear = await stores[0]!.getOrCreate(session, digest, 2);
    expect(afterClear.idempotencyKey).not.toBe(originalKey);

    timestamp += 1_001;
    const afterExpiry = await stores[0]!.getOrCreate(session, digest, 2);
    expect(afterExpiry.idempotencyKey).not.toBe(afterClear.idempotencyKey);
  });

  it("persists resumable opens in private files and expires them", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    let timestamp = Date.parse("2026-09-02T00:00:00.000Z");
    const store = new PendingOpenStore(directory, {
      now: () => new Date(timestamp),
      ttlMs: 1_000,
    });
    const inputDigest = pendingOpenDigest({
      prompt: "Check the header.",
      screenshotPaths: [],
    });
    const created = {
      raiseId: "r_open",
      ownerClaimUrl: "https://raise.example/r/r_open#token=cap_owner.private-secret",
      targetClaimUrl: "https://raise.example/r/r_open#token=cap_target.private-secret",
      targetRole: "human" as const,
    };

    await expect(store.put(inputDigest, created)).resolves.toEqual(created);
    await expect(
      new PendingOpenStore(directory, {
        now: () => new Date(timestamp),
        ttlMs: 1_000,
      }).get(inputDigest),
    ).resolves.toEqual(created);
    const pendingFiles = (await readdir(directory)).filter((file) =>
      file.startsWith("pending-open-"),
    );
    expect(pendingFiles).toHaveLength(1);
    expect((await stat(join(directory, pendingFiles[0]!))).mode & 0o777).toBe(0o600);

    timestamp += 1_001;
    await expect(store.get(inputDigest)).resolves.toBeUndefined();
    expect(
      (await readdir(directory)).filter((file) => file.startsWith("pending-open-")),
    ).toHaveLength(0);
  });
});
