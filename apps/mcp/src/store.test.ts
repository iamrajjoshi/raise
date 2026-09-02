import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pendingOpenDigest,
  PendingExchangeStore,
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
      expiresInHours: 24,
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
