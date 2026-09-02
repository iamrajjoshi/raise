import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimResponse, CreateRaiseResponse, InboxResponse, RaiseView } from "@raise/protocol";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("default-project agent inbox", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let databasePath: string;
  let inboxToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "raise-inbox-test-"));
    databasePath = join(dataDir, "raise.db");
    inboxToken = randomBytes(32).toString("base64url");
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
      inboxToken,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function inboxAuth(token = inboxToken) {
    return { authorization: `Bearer ${token}` };
  }

  async function create(origin: "human" | "agent", title: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: { origin, title, prompt: title },
    });
    expect(response.statusCode).toBe(201);
    return response.json<CreateRaiseResponse>();
  }

  it("rejects disabled, missing, non-Bearer, and incorrect authentication", async () => {
    await app.close();
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
    });

    const disabled = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toMatchObject({ code: "inbox_disabled" });

    await app.close();
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
      inboxToken,
    });

    const missing = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(missing.statusCode).toBe(401);

    const cookieOnly = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: `raise_session_inbox=${inboxToken}` },
    });
    expect(cookieOnly.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: inboxAuth(`${inboxToken}-wrong`),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "unauthorized" });
  });

  it("requires a token of at least 32 characters when configured", async () => {
    await app.close();
    await expect(
      createApp({
        databasePath,
        dataDir,
        publicBaseUrl: "http://raise.test",
        inboxToken: "too-short",
      }),
    ).rejects.toThrow("RAISE_INBOX_TOKEN must be at least 32 characters");

    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
      inboxToken,
    });
  });

  it("lists only non-expired open requests with agent turns first", async () => {
    const olderAgentTurn = await create("human", "Older agent turn");
    const newerAgentTurn = await create("human", "Newer agent turn");
    const humanTurn = await create("agent", "Human turn");
    const expired = await create("human", "Expired request");
    const resolved = await create("human", "Resolved request");

    const inspection = new Database(databasePath);
    inspection
      .prepare("UPDATE raises SET updated_at = ? WHERE id = ?")
      .run("2026-09-01T10:00:00.000Z", olderAgentTurn.raiseId);
    inspection
      .prepare("UPDATE raises SET updated_at = ? WHERE id = ?")
      .run("2026-09-01T11:00:00.000Z", newerAgentTurn.raiseId);
    inspection
      .prepare("UPDATE raises SET updated_at = ? WHERE id = ?")
      .run("2026-09-01T12:00:00.000Z", humanTurn.raiseId);
    inspection
      .prepare("UPDATE raises SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.raiseId);
    inspection
      .prepare("UPDATE raises SET lifecycle = 'resolved' WHERE id = ?")
      .run(resolved.raiseId);
    inspection.close();

    const response = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: inboxAuth(),
    });
    expect(response.statusCode).toBe(200);
    const inbox = response.json<InboxResponse>();
    expect(inbox.items.map((item) => item.raiseId)).toEqual([
      newerAgentTurn.raiseId,
      olderAgentTurn.raiseId,
      humanTurn.raiseId,
    ]);
    expect(inbox.items.map((item) => item.waitingOn)).toEqual(["agent", "agent", "human"]);
    expect(inbox.items[0]).toMatchObject({
      title: "Newer agent turn",
      origin: "human",
      pendingAction: "perform_work",
      version: 1,
    });

    const limited = await app.inject({
      method: "GET",
      url: "/api/inbox?limit=2",
      headers: inboxAuth(),
    });
    expect(limited.json<InboxResponse>().items).toHaveLength(2);

    const invalidLimit = await app.inject({
      method: "GET",
      url: "/api/inbox?limit=101",
      headers: inboxAuth(),
    });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.json()).toMatchObject({ code: "invalid_request" });
  });

  it("mints only agent sessions for an open inbox request", async () => {
    const created = await create("agent", "Human context needed");
    const response = await app.inject({
      method: "POST",
      url: `/api/inbox/${created.raiseId}/session`,
      headers: inboxAuth(),
    });
    expect(response.statusCode).toBe(200);
    const session = response.json<ClaimResponse>();
    expect(session).toMatchObject({ raiseId: created.raiseId, role: "agent" });
    expect(session.token).toMatch(/^ses_/);

    const read = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<RaiseView>().viewerRole).toBe("agent");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/inbox/r_unknown/session",
      headers: inboxAuth(),
    });
    expect(unknown.statusCode).toBe(404);

    const inspection = new Database(databasePath);
    inspection
      .prepare("UPDATE raises SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", created.raiseId);
    inspection.close();
    const expired = await app.inject({
      method: "POST",
      url: `/api/inbox/${created.raiseId}/session`,
      headers: inboxAuth(),
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ code: "raise_expired" });
  });

  it("lists and opens inbox work after a server restart", async () => {
    const created = await create("human", "Survives restart");
    await app.close();
    app = await createApp({
      databasePath,
      dataDir,
      publicBaseUrl: "http://raise.test",
      inboxToken,
    });

    const inbox = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: inboxAuth(),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json<InboxResponse>().items.map((item) => item.raiseId)).toContain(
      created.raiseId,
    );

    const session = await app.inject({
      method: "POST",
      url: `/api/inbox/${created.raiseId}/session`,
      headers: inboxAuth(),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json<ClaimResponse>()).toMatchObject({
      raiseId: created.raiseId,
      role: "agent",
      token: expect.stringMatching(/^ses_/),
    });
  });
});
