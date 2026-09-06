import { createClient } from "@redis/client";
import type { Role } from "@raise/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityKind } from "../src/capabilities.js";
import type {
  AppendEntryCommand,
  CapabilityProof,
  CapabilityWrite,
  CreateRaiseCommand,
} from "../src/storage.js";
import { RAISE_HARD_TTL_MS, RAISE_IDLE_TTL_MS } from "../src/retention.js";
import { VALKEY_APPEND_ENTRY_SCRIPT, VALKEY_COMMIT_CLAIM_SCRIPT } from "../src/valkey-scripts.js";
import { ValkeyRaiseStore, valkeyRaiseKeys } from "../src/valkey-store.js";
import { defineRaiseStoreContract } from "./raise-store.contract.js";
import {
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

let server: ValkeyTestServer;

beforeAll(async () => {
  server = await startValkeyTestServer();
});

afterAll(async () => server?.stop());

defineRaiseStoreContract("Valkey", async () => createValkeyTestStore(server.url, "contract"));

describe("Valkey RaiseStore scripts", () => {
  it("uses one hash slot for all per-Raise keys", () => {
    const keys = Object.values(valkeyRaiseKeys("r_slot_test", "scope:"));
    expect(keys).toHaveLength(4);
    expect(keys.every((key) => key.includes("{r_slot_test}"))).toBe(true);
  });

  it("uses absolute expiry only in mutation scripts", () => {
    expect(RAISE_IDLE_TTL_MS).toBe(7_200_000);
    expect(RAISE_HARD_TTL_MS).toBe(21_600_000);
    expect(VALKEY_APPEND_ENTRY_SCRIPT).toContain("PEXPIREAT");
    expect(VALKEY_APPEND_ENTRY_SCRIPT).not.toContain("redis.call('PEXPIRE',");
    expect(VALKEY_COMMIT_CLAIM_SCRIPT).not.toContain("now_ms +");
  });
});

function capability(id: string, role: Role, kind: CapabilityKind): CapabilityWrite {
  return {
    id,
    role,
    kind,
    secretDigest: kind === "claim" ? "a".repeat(64) : "b".repeat(64),
    contentKeyEnvelope: `wk1.${id}`,
  };
}

function createCommand(suffix: string): CreateRaiseCommand {
  return {
    raiseId: `r_ttl_${suffix}`,
    entryId: `e_ttl_${suffix}`,
    actionId: `a_ttl_${suffix}`,
    remainingHardTtlMs: RAISE_HARD_TTL_MS,
    origin: "human",
    titleEnvelope: `v1.title_${suffix}`,
    prompt: { bodyEnvelope: `v1.body_${suffix}` },
    attachments: [],
    ownerClaim: capability(`c_human_${suffix}`, "human", "claim"),
    targetClaim: capability(`c_agent_${suffix}`, "agent", "claim"),
  };
}

function idempotency(suffix: string) {
  return {
    keyDigest: Buffer.from(`key:${suffix}`).toString("hex").padEnd(64, "0").slice(0, 64),
    requestDigest: Buffer.from(`request:${suffix}`).toString("hex").padEnd(64, "0").slice(0, 64),
  };
}

async function claimSession(
  store: ValkeyRaiseStore,
  command: CreateRaiseCommand,
  role: Role,
  exchangeDigest?: string,
): Promise<CapabilityProof> {
  const claim = role === "human" ? command.ownerClaim : command.targetClaim;
  const proof = { id: claim.id, secretDigest: claim.secretDigest };
  const inspection = {
    raiseId: command.raiseId,
    claim: proof,
    mode: "token",
    expectedRole: role,
    ...(exchangeDigest ? { exchangeDigest } : {}),
  } as const;
  const inspected = await store.inspectClaim(inspection);
  const session = capability(`s_${role}_${command.raiseId}`, role, "session");
  const committed = await store.commitClaimExchange({
    ...inspection,
    session,
  });
  expect(committed.sessionExpiresAt).toBe(inspected.sessionExpiresAt);
  return { id: session.id, secretDigest: session.secretDigest };
}

describe("Valkey RaiseStore retention", () => {
  it("subtracts creation work from the six-hour hard deadline", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-ttl:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("delayed_create");
    const simulatedCreationWorkMs = 30 * 60 * 1_000;
    command.remainingHardTtlMs = RAISE_HARD_TTL_MS - simulatedCreationWorkMs;
    const beforeCreate = Date.now();

    await store.createRaise(command);

    const afterCreate = Date.now();
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    const hardDeadline = Number(await client.sendCommand(["HGET", keys.meta, "hardExpiresAtMs"]));
    expect(hardDeadline).toBeGreaterThanOrEqual(beforeCreate + command.remainingHardTtlMs);
    expect(hardDeadline).toBeLessThanOrEqual(afterCreate + command.remainingHardTtlMs);
    expect(hardDeadline).toBeLessThan(beforeCreate + RAISE_HARD_TTL_MS);
    await store.close();
  });

  it("uses the remaining hard budget when it is shorter than the idle lifetime", async () => {
    const fixture = await createValkeyTestStore(server.url, "short-budget");
    const command = createCommand("short_budget");
    command.remainingHardTtlMs = 17 * 60 * 1_000;
    const beforeCreate = Date.now();

    try {
      await fixture.store.createRaise(command);
      const afterCreate = Date.now();
      const keys = Object.values(valkeyRaiseKeys(command.raiseId, fixture.keyPrefix));
      const deadlines = await Promise.all(
        keys.map(async (key) => Number(await fixture.client.sendCommand(["PEXPIRETIME", key]))),
      );
      expect(new Set(deadlines).size).toBe(1);
      expect(deadlines[0]).toBeGreaterThanOrEqual(beforeCreate + command.remainingHardTtlMs);
      expect(deadlines[0]).toBeLessThanOrEqual(afterCreate + command.remainingHardTtlMs);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([0, -1, 1.5, RAISE_HARD_TTL_MS + 1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid remaining hard budget %s without writing state",
    async (remainingHardTtlMs) => {
      const fixture = await createValkeyTestStore(server.url, "invalid-budget");
      const command = createCommand("invalid_budget");
      command.remainingHardTtlMs = remainingHardTtlMs;

      try {
        await expect(fixture.store.createRaise(command)).rejects.toThrow(
          "remaining hard retention duration is invalid",
        );
        const keys = Object.values(valkeyRaiseKeys(command.raiseId, fixture.keyPrefix));
        await expect(fixture.client.sendCommand(["EXISTS", ...keys])).resolves.toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("keeps a Stream cursor readable after reconnecting", async () => {
    const fixture = await createValkeyTestStore(server.url, "reconnect-cursor");
    const command = createCommand("reconnect_cursor");
    const human = {
      id: `s_human_${command.raiseId}`,
      secretDigest: "b".repeat(64),
    };

    try {
      await fixture.store.createRaise(command);
      await fixture.store.commitClaimExchange({
        raiseId: command.raiseId,
        claim: {
          id: command.ownerClaim.id,
          secretDigest: command.ownerClaim.secretDigest,
        },
        mode: "token",
        session: {
          ...human,
          role: "human",
          kind: "session",
          contentKeyEnvelope: "wk1.reconnect_cursor",
        },
      });
      const snapshot = await fixture.store.getRaise(command.raiseId, human);
      expect(snapshot).toMatchObject({ entriesMode: "snapshot" });

      await fixture.client.close();
      const reconnected = createClient({ url: server.url, disableOfflineQueue: true });
      reconnected.on("error", () => undefined);
      await reconnected.connect();
      const reopened = new ValkeyRaiseStore(reconnected, { keyPrefix: fixture.keyPrefix });
      await expect(
        reopened.getRaise(command.raiseId, human, { after: snapshot.cursor }),
      ).resolves.toMatchObject({
        cursor: snapshot.cursor,
        entriesMode: "delta",
        entries: [],
      });
      await reopened.close();
    } finally {
      await fixture.cleanup();
    }
  });

  it("sets every key to the same two-hour deadline and does not extend it on reads or claims", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-ttl:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("read_claim");
    await store.createRaise(command);
    const keys = Object.values(valkeyRaiseKeys(command.raiseId, prefix));
    const initial = await Promise.all(
      keys.map(async (key) => Number(await client.sendCommand(["PEXPIRETIME", key]))),
    );
    expect(new Set(initial).size).toBe(1);
    expect(initial[0]! - Date.now()).toBeGreaterThan(RAISE_IDLE_TTL_MS - 2_000);
    expect(initial[0]! - Date.now()).toBeLessThanOrEqual(RAISE_IDLE_TTL_MS);
    const hardDeadline = Number(await client.sendCommand(["HGET", keys[0]!, "hardExpiresAtMs"]));
    expect(hardDeadline - Date.now()).toBeGreaterThan(RAISE_HARD_TTL_MS - 2_000);
    expect(hardDeadline - Date.now()).toBeLessThanOrEqual(RAISE_HARD_TTL_MS);

    const initialInspection = await store.inspectClaim({
      raiseId: command.raiseId,
      claim: {
        id: command.ownerClaim.id,
        secretDigest: command.ownerClaim.secretDigest,
      },
      mode: "token",
      expectedRole: "human",
    });
    expect(Date.parse(initialInspection.expiresAt)).toBe(initial[0]);
    expect(Date.parse(initialInspection.sessionExpiresAt)).toBe(hardDeadline);

    const exchangeDigest = "c".repeat(64);
    const human = await claimSession(store, command, "human", exchangeDigest);
    const snapshot = await store.getRaise(command.raiseId, human);
    await expect(
      store.getRaise(command.raiseId, human, { after: snapshot.cursor }),
    ).resolves.toMatchObject({ entriesMode: "delta", entries: [] });
    await expect(
      store.inspectClaim({
        raiseId: command.raiseId,
        claim: {
          id: command.ownerClaim.id,
          secretDigest: command.ownerClaim.secretDigest,
        },
        mode: "token",
        expectedRole: "human",
        exchangeDigest,
      }),
    ).resolves.toMatchObject({
      expiresAt: new Date(initial[0]!).toISOString(),
      sessionExpiresAt: new Date(hardDeadline).toISOString(),
      existingExchange: { sessionCapabilityId: human.id },
    });
    const after = await Promise.all(
      keys.map(async (key) => Number(await client.sendCommand(["PEXPIRETIME", key]))),
    );
    expect(after).toEqual(initial);
    await store.close();
  });

  it("returns a replacement snapshot when a Stream cursor has been trimmed", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-cursor:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("trimmed_cursor");
    await store.createRaise(command);
    const agent = await claimSession(store, command, "agent");
    const initial = await store.getRaise(command.raiseId, agent);
    await store.appendEntry({
      raiseId: command.raiseId,
      entryId: "e_trimmed_cursor_result",
      nextActionId: "a_trimmed_cursor_review",
      session: agent,
      transition: { kind: "result", expectedVersion: 1 },
      idempotency: idempotency("trimmed-cursor"),
      content: { bodyEnvelope: "v1.trimmed_cursor_result" },
      attachments: [],
    });

    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    await client.sendCommand(["XTRIM", keys.entries, "MAXLEN", "=", "1"]);

    await expect(
      store.getRaise(command.raiseId, agent, { after: initial.cursor }),
    ).resolves.toMatchObject({
      version: 2,
      entriesMode: "snapshot",
      entries: [{ id: "e_trimmed_cursor_result" }],
    });
    await store.close();
  });

  it("extends only successful writes, caps them at six hours, and shortens acceptance to 15 minutes", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-ttl:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("writes");
    await store.createRaise(command);
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    const agent = await claimSession(store, command, "agent");
    const human = await claimSession(store, command, "human");
    const oneHourFromNow = Date.now() + 60 * 60 * 1_000;
    const hardDeadline = Date.now() + 90 * 60 * 1_000;
    for (const key of Object.values(keys)) {
      await client.sendCommand(["PEXPIREAT", key, String(oneHourFromNow)]);
    }
    await client.sendCommand([
      "HSET",
      keys.meta,
      "expiresAtMs",
      String(oneHourFromNow),
      "hardExpiresAtMs",
      String(hardDeadline),
    ]);

    const result: AppendEntryCommand = {
      raiseId: command.raiseId,
      entryId: "e_result_ttl",
      nextActionId: "a_review_ttl",
      session: agent,
      transition: { kind: "result", expectedVersion: 1 },
      idempotency: idempotency("result-ttl"),
      content: { bodyEnvelope: "v1.result" },
      attachments: [],
    };
    await store.appendEntry(result);
    const extended = Number(await client.sendCommand(["HGET", keys.meta, "expiresAtMs"]));
    expect(extended).toBe(hardDeadline);
    const beforeReplay = await Promise.all(
      Object.values(keys).map(async (key) =>
        Number(await client.sendCommand(["PEXPIRETIME", key])),
      ),
    );

    await expect(store.appendEntry(result)).resolves.toMatchObject({
      status: "replayed",
      receipt: { entryId: result.entryId, resultingVersion: 2 },
    });
    expect(Number(await client.sendCommand(["HGET", keys.meta, "expiresAtMs"]))).toBe(extended);
    await expect(
      Promise.all(
        Object.values(keys).map(async (key) =>
          Number(await client.sendCommand(["PEXPIRETIME", key])),
        ),
      ),
    ).resolves.toEqual(beforeReplay);

    await store.appendEntry({
      raiseId: command.raiseId,
      entryId: "e_accept_ttl",
      nextActionId: "a_unused_ttl",
      session: human,
      transition: { kind: "review_decision", expectedVersion: 2, decision: "accept" },
      idempotency: idempotency("accept-ttl"),
      content: { bodyEnvelope: "v1.accept", decisionEnvelope: "v1.accept_decision" },
      attachments: [],
    });
    const accepted = Number(await client.sendCommand(["HGET", keys.meta, "expiresAtMs"]));
    expect(accepted - Date.now()).toBeGreaterThan(15 * 60 * 1_000 - 2_000);
    expect(accepted - Date.now()).toBeLessThanOrEqual(15 * 60 * 1_000);
    expect(accepted).toBeLessThan(extended);
    const deadlines = await Promise.all(
      Object.values(keys).map(async (key) =>
        Number(await client.sendCommand(["PEXPIRETIME", key])),
      ),
    );
    expect(new Set(deadlines).size).toBe(1);
    await store.close();
  });

  it("fails closed when a per-Raise key is missing and does not recreate lost history", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-corrupt:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("missing_stream");
    await store.createRaise(command);
    const agent = await claimSession(store, command, "agent");
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    await client.sendCommand(["DEL", keys.entries]);

    await expect(store.getRaise(command.raiseId, agent)).rejects.toThrow(
      "incomplete or invalid Raise bundle",
    );
    await expect(
      store.appendEntry({
        raiseId: command.raiseId,
        entryId: "e_must_not_appear",
        nextActionId: "a_must_not_appear",
        session: agent,
        transition: { kind: "result", expectedVersion: 1 },
        idempotency: idempotency("missing-stream"),
        content: { bodyEnvelope: "v1.must_not_appear" },
        attachments: [],
      }),
    ).rejects.toThrow("incomplete or invalid Raise bundle");
    await expect(client.sendCommand(["EXISTS", keys.entries])).resolves.toBe(0);
    await expect(client.sendCommand(["HGET", keys.meta, "version"])).resolves.toBe("1");
    await expect(
      client.sendCommand(["HEXISTS", keys.meta, "entry:e_must_not_appear"]),
    ).resolves.toBe(0);
    await store.close();
  });

  it("validates the hard deadline before an append makes any write", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-corrupt:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("bad_deadline");
    await store.createRaise(command);
    const agent = await claimSession(store, command, "agent");
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    const entryCount = await client.sendCommand(["XLEN", keys.entries]);
    await client.sendCommand(["HSET", keys.meta, "hardExpiresAtMs", "not-a-number"]);

    await expect(
      store.appendEntry({
        raiseId: command.raiseId,
        entryId: "e_must_not_commit",
        nextActionId: "a_must_not_commit",
        session: agent,
        transition: { kind: "result", expectedVersion: 1 },
        idempotency: idempotency("bad-deadline"),
        content: { bodyEnvelope: "v1.must_not_commit" },
        attachments: [],
      }),
    ).rejects.toThrow("incomplete or invalid Raise bundle");
    await expect(client.sendCommand(["XLEN", keys.entries])).resolves.toBe(entryCount);
    await expect(client.sendCommand(["HGET", keys.meta, "version"])).resolves.toBe("1");
    await store.close();
  });

  it("does not repair or extend a drifted key deadline during a claim", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-corrupt:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("drifted_ttl");
    await store.createRaise(command);
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    const shorterDeadline = Date.now() + 60_000;
    await client.sendCommand(["PEXPIREAT", keys.idempotency, String(shorterDeadline)]);
    const before = await client.sendCommand(["PEXPIRETIME", keys.idempotency]);

    await expect(
      store.inspectClaim({
        raiseId: command.raiseId,
        claim: {
          id: command.ownerClaim.id,
          secretDigest: command.ownerClaim.secretDigest,
        },
        mode: "token",
        expectedRole: "human",
      }),
    ).rejects.toThrow("incomplete or invalid Raise bundle");
    await expect(client.sendCommand(["PEXPIRETIME", keys.idempotency])).resolves.toBe(before);
    await store.close();
  });

  it("erases the consumed claim's live content-key wrap", async () => {
    const client = createClient({ url: server.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    const prefix = `raise-claim:${crypto.randomUUID()}:`;
    const store = new ValkeyRaiseStore(client, { keyPrefix: prefix });
    const command = createCommand("erased_wrap");
    await store.createRaise(command);
    await claimSession(store, command, "human", "d".repeat(64));
    const keys = valkeyRaiseKeys(command.raiseId, prefix);
    const stored = await client.sendCommand(["HGET", keys.capabilities, command.ownerClaim.id]);

    expect(JSON.parse(String(stored))).toMatchObject({
      kind: "claim",
      contentKeyEnvelope: "",
    });
    await store.close();
  });
});
