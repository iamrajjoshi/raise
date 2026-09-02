import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimResponse, CreateRaiseResponse, RaiseView } from "@raise/protocol";
import { createApp } from "../src/app.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requestTitle = "Billing empty state is clipped on mobile";

function claimToken(url: string) {
  return new URL(url).hash.slice("#token=".length);
}

function replaySecret() {
  return randomBytes(32).toString("base64url");
}

async function expectDatabaseArtifactsNotToContain(databasePath: string, sentinel: Buffer) {
  for (const artifact of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(artifact)) {
      expect((await readFile(artifact)).includes(sentinel), artifact).toBe(false);
    }
  }
}

describe("Raise closed loop", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let databasePath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "raise-test-"));
    databasePath = join(dataDir, "raise.db");
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function create(origin: "human" | "agent", withImage = false) {
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin,
        prompt: `${requestTitle}\n\n${
          origin === "human"
            ? "Fix the clipped billing empty state."
            : "Which empty state is wrong?"
        }`,
        url: "http://localhost:3000/billing",
        attachments: withImage
          ? [{ name: "billing.png", mimeType: "image/png", dataUrl: onePixelPng }]
          : [],
        expiresInHours: 24,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<CreateRaiseResponse>();
  }

  async function exchange(url: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token: claimToken(url), mode: "token" },
    });
    expect(response.statusCode).toBe(200);
    const claim = response.json<ClaimResponse>();
    expect(claim.token).toBeTruthy();
    return claim.token as string;
  }

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it("completes a human-started result and acceptance", async () => {
    const created = await create("human", true);
    const humanToken = await exchange(created.ownerClaimUrl);
    const agentToken = await exchange(created.targetClaimUrl);

    const initial = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(humanToken),
    });
    const initialView = initial.json<RaiseView>();
    expect(initialView.title).toBe(requestTitle);
    expect(initialView.waitingOn).toBe("agent");
    expect(initialView.entries[0]?.attachments).toHaveLength(1);

    const result = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(agentToken),
      payload: {
        kind: "result",
        body: "Fixed the mobile overflow and checked the 375 px layout.",
        attachments: [],
        expectedVersion: 1,
      },
    });
    expect(result.statusCode).toBe(201);
    const resultView = result.json<RaiseView>();
    expect(resultView.waitingOn).toBe("human");
    expect(resultView.permissions.canReview).toBe(false);

    const humanViewResponse = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(humanToken),
    });
    const humanView = humanViewResponse.json<RaiseView>();
    expect(humanView.permissions.canReview).toBe(true);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(humanToken),
      payload: {
        kind: "review_decision",
        decision: "accept",
        body: "",
        attachments: [],
        expectedVersion: 2,
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json<RaiseView>()).toMatchObject({
      lifecycle: "resolved",
      waitingOn: null,
      version: 3,
    });
  });

  it("completes an agent-started context exchange and a changes cycle", async () => {
    const created = await create("agent");
    const agentToken = await exchange(created.ownerClaimUrl);
    const humanToken = await exchange(created.targetClaimUrl);

    const response = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(humanToken),
      payload: {
        kind: "response",
        body: "The mobile billing route at 375 px; the callout clips on the right.",
        attachments: [],
        expectedVersion: 1,
      },
    });
    expect(response.json<RaiseView>().waitingOn).toBe("agent");

    const result = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(agentToken),
      payload: {
        kind: "result",
        body: "Adjusted the grid min-width.",
        attachments: [],
        expectedVersion: 2,
      },
    });
    expect(result.json<RaiseView>().waitingOn).toBe("human");

    const changes = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(humanToken),
      payload: {
        kind: "review_decision",
        decision: "request_changes",
        body: "The button still wraps at 320 px.",
        attachments: [],
        expectedVersion: 3,
      },
    });
    expect(changes.json<RaiseView>()).toMatchObject({
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "make_changes",
    });
  });

  it("consumes a claim once and scopes sessions to one Raise", async () => {
    const first = await create("human");
    const second = await create("human");
    const firstToken = await exchange(first.ownerClaimUrl);

    const reused = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token: claimToken(first.ownerClaimUrl), mode: "token" },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ code: "invalid_capability" });

    const crossRaise = await app.inject({
      method: "GET",
      url: `/api/raises/${second.raiseId}`,
      headers: auth(firstToken),
    });
    expect(crossRaise.statusCode).toBe(401);
  });

  it("rejects the wrong role without consuming the claim", async () => {
    const created = await create("human");
    const wrongRole = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        token: claimToken(created.targetClaimUrl),
        mode: "token",
        expectedRole: "human",
      },
    });
    expect(wrongRole.statusCode).toBe(403);
    expect(wrongRole.json()).toMatchObject({ code: "wrong_role" });

    const agentToken = await exchange(created.targetClaimUrl);
    expect(agentToken).toMatch(/^ses_/);
  });

  it("replays one claim exchange ID but rejects a different exchange", async () => {
    const created = await create("human");
    const token = claimToken(created.targetClaimUrl);
    const exchangeId = replaySecret();
    const first = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(first.statusCode).toBe(200);

    const inspection = new Database(databasePath, { readonly: true });
    const storedExchange = inspection
      .prepare("SELECT exchange_id, exchange_id_hash, exchange_mode FROM claim_exchanges")
      .get() as {
      exchange_id: string;
      exchange_id_hash: string;
      exchange_mode: string;
    };
    inspection.close();
    expect(storedExchange).toEqual({
      exchange_id: "",
      exchange_id_hash: createHash("sha256").update(exchangeId).digest("hex"),
      exchange_mode: "token",
    });

    await app.close();
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const [claimId] = token.split(".");
    const forged = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        token: `${claimId}.${"A".repeat(43)}`,
        mode: "token",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ code: "invalid_capability" });

    const differentExchange = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        token,
        mode: "token",
        expectedRole: "agent",
        exchangeId: replaySecret(),
      },
    });
    expect(differentExchange.statusCode).toBe(401);
    expect(differentExchange.json()).toMatchObject({ code: "invalid_capability" });
  });

  it("binds a claim replay to its original delivery mode", async () => {
    const created = await create("human");
    const token = claimToken(created.targetClaimUrl);
    const exchangeId = replaySecret();
    const first = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "cookie", expectedRole: "agent", exchangeId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<ClaimResponse>().token).toBeUndefined();
    expect(first.headers["set-cookie"]).toContain("raise_session_");

    const tokenReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(tokenReplay.statusCode).toBe(401);
    expect(tokenReplay.json()).toMatchObject({ code: "invalid_capability" });

    const cookieReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "cookie", expectedRole: "agent", exchangeId },
    });
    expect(cookieReplay.statusCode).toBe(200);
    expect(cookieReplay.json()).toEqual(first.json());
    expect(cookieReplay.headers["set-cookie"]).toBe(first.headers["set-cookie"]);
  });

  it("invalidates every pre-mode claim replay while preserving its existing session", async () => {
    const created = await create("human");
    const token = claimToken(created.targetClaimUrl);
    const exchangeId = createHash("sha256")
      .update("raise-claim-exchange-v1\0")
      .update(token)
      .digest("base64url");
    const first = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(first.statusCode).toBe(200);
    const originalSession = first.json<ClaimResponse>().token as string;
    await app.close();

    const legacyDatabase = new Database(databasePath);
    const exchange = legacyDatabase
      .prepare("SELECT claim_id, session_capability_id, created_at FROM claim_exchanges")
      .get() as {
      claim_id: string;
      session_capability_id: string;
      created_at: string;
    };
    legacyDatabase.pragma("foreign_keys = OFF");
    legacyDatabase.exec("DROP TABLE claim_exchanges");
    legacyDatabase.exec(`
      CREATE TABLE claim_exchanges (
        claim_id TEXT PRIMARY KEY REFERENCES capabilities(id) ON DELETE CASCADE,
        exchange_id TEXT NOT NULL,
        session_capability_id TEXT NOT NULL UNIQUE REFERENCES capabilities(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      )
    `);
    legacyDatabase
      .prepare(
        `INSERT INTO claim_exchanges
         (claim_id, exchange_id, session_capability_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(exchange.claim_id, exchangeId, exchange.session_capability_id, exchange.created_at);
    legacyDatabase.close();
    const sentinel = Buffer.from(exchangeId);
    expect((await readFile(databasePath)).includes(sentinel)).toBe(true);

    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
    });
    await expectDatabaseArtifactsNotToContain(databasePath, sentinel);
    if (existsSync(`${databasePath}-wal`)) {
      expect((await readFile(`${databasePath}-wal`)).byteLength).toBe(0);
    }

    const migratedDatabase = new Database(databasePath, { readonly: true });
    const exchangeCount = migratedDatabase
      .prepare("SELECT COUNT(*) AS count FROM claim_exchanges")
      .get() as { count: number };
    const claim = migratedDatabase
      .prepare("SELECT consumed_at FROM capabilities WHERE id = ?")
      .get(exchange.claim_id) as { consumed_at: string | null };
    const session = migratedDatabase
      .prepare("SELECT id FROM capabilities WHERE id = ? AND kind = 'session'")
      .get(exchange.session_capability_id) as { id: string } | undefined;
    const columns = migratedDatabase.pragma("table_info(claim_exchanges)") as Array<{
      name: string;
    }>;
    migratedDatabase.close();
    expect(exchangeCount.count).toBe(0);
    expect(claim.consumed_at).not.toBeNull();
    expect(session?.id).toBe(exchange.session_capability_id);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["exchange_id_hash", "exchange_mode"]),
    );

    await app.close();
    await expectDatabaseArtifactsNotToContain(databasePath, sentinel);
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
    });

    const existingSession = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(originalSession),
    });
    expect(existingSession.statusCode).toBe(200);

    const tokenReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(tokenReplay.statusCode).toBe(401);
    expect(tokenReplay.json()).toMatchObject({ code: "invalid_capability" });

    const cookieReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "cookie", expectedRole: "agent", exchangeId },
    });
    expect(cookieReplay.statusCode).toBe(401);
    expect(cookieReplay.json()).toMatchObject({ code: "invalid_capability" });
  });

  it("rolls back the whole first exchange if replay persistence fails", async () => {
    const created = await create("human");
    const token = claimToken(created.targetClaimUrl);
    const claimId = token.slice(0, token.indexOf(".")).slice("cap_".length);
    const exchangeId = replaySecret();
    const inspection = new Database(databasePath);
    inspection.exec(`
      CREATE TRIGGER reject_claim_exchange
      BEFORE INSERT ON claim_exchanges
      BEGIN
        SELECT RAISE(ABORT, 'injected exchange failure');
      END
    `);
    inspection.close();

    const failed = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(failed.statusCode).toBe(500);

    const afterFailure = new Database(databasePath);
    const claim = afterFailure
      .prepare("SELECT consumed_at FROM capabilities WHERE id = ?")
      .get(claimId) as { consumed_at: string | null };
    const sessionCount = afterFailure
      .prepare("SELECT COUNT(*) AS count FROM capabilities WHERE kind = 'session'")
      .get() as { count: number };
    const exchangeCount = afterFailure
      .prepare("SELECT COUNT(*) AS count FROM claim_exchanges")
      .get() as { count: number };
    expect(claim.consumed_at).toBeNull();
    expect(sessionCount.count).toBe(0);
    expect(exchangeCount.count).toBe(0);
    afterFailure.exec("DROP TRIGGER reject_claim_exchange");
    afterFailure.close();

    const retry = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { token, mode: "token", expectedRole: "agent", exchangeId },
    });
    expect(retry.statusCode).toBe(200);
  });

  it("stores sanitized image bytes and serves them only with Raise access", async () => {
    const created = await create("human", true);
    const humanToken = await exchange(created.ownerClaimUrl);
    const viewResponse = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(humanToken),
    });
    const attachment = viewResponse.json<RaiseView>().entries[0]?.attachments[0];
    expect(attachment).toBeTruthy();

    const image = await app.inject({
      method: "GET",
      url: attachment?.url as string,
      headers: auth(humanToken),
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/webp");
    expect(image.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");

    const storedFiles = await readFile(join(dataDir, "blobs", `${attachment?.id}.webp`));
    expect(storedFiles.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("creates a screenshot-only request with a useful title", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: "",
        attachments: [{ name: "billing.png", mimeType: "image/png", dataUrl: onePixelPng }],
        expiresInHours: 24,
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<CreateRaiseResponse>();
    const humanToken = await exchange(created.ownerClaimUrl);
    const view = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(humanToken),
    });

    expect(view.json<RaiseView>()).toMatchObject({
      title: "billing.png",
      entries: [{ body: "", attachments: [{ name: "billing.png" }] }],
    });
  });

  it("accepts more than four small screenshots in a request and result", async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      name: `screen-${index + 1}.png`,
      mimeType: "image/png",
      dataUrl: onePixelPng,
    }));
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: "Compare all five breakpoints.",
        attachments,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<CreateRaiseResponse>();
    const agentToken = await exchange(created.targetClaimUrl);

    const initial = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(agentToken),
    });
    expect(initial.json<RaiseView>().entries[0]?.attachments).toHaveLength(5);

    const result = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(agentToken),
      payload: {
        kind: "result",
        body: "Checked every breakpoint.",
        attachments,
        expectedVersion: 1,
      },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json<RaiseView>().entries[1]?.attachments).toHaveLength(5);
  });

  it("returns 413 when the JSON body exceeds the transport limit", async () => {
    await app.close();
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
      bodyLimit: 256,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: "x".repeat(300),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("does not create an empty scratchpad", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: { origin: "human", prompt: "", attachments: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("rejects bad images before creating or advancing a request", async () => {
    const badImage = {
      name: "broken.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,bm90IGFuIGltYWdl",
    };
    const rejectedCreate = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: "This should not be saved.",
        attachments: [badImage],
      },
    });
    expect(rejectedCreate.statusCode).toBe(400);

    const inspection = new Database(databasePath, { readonly: true });
    const count = inspection.prepare("SELECT COUNT(*) AS count FROM raises").get() as {
      count: number;
    };
    inspection.close();
    expect(count.count).toBe(0);

    const created = await create("human");
    const agentToken = await exchange(created.targetClaimUrl);
    const rejectedResult = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers: auth(agentToken),
      payload: {
        kind: "result",
        body: "This should not be saved either.",
        attachments: [badImage],
        expectedVersion: 1,
      },
    });
    expect(rejectedResult.statusCode).toBe(400);

    const unchanged = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(agentToken),
    });
    expect(unchanged.json<RaiseView>()).toMatchObject({
      version: 1,
      waitingOn: "agent",
    });
    expect(unchanged.json<RaiseView>().entries).toHaveLength(1);
  });
});
