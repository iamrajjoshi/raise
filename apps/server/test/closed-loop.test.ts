import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClaimResponse, CreateRaiseResponse, RaiseView, Role } from "@raise/protocol";
import { valkeyRaiseKeys } from "../src/valkey-store.js";
import {
  createValkeyTestApp,
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requestTitle = "Billing empty state is clipped on mobile";

function claimToken(url: string) {
  return new URL(url).hash.slice("#token=".length);
}

function replaySecret() {
  return randomBytes(32).toString("base64url");
}

describe("Raise closed loop", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let server: ValkeyTestServer;
  let testStore: Awaited<ReturnType<typeof createValkeyTestStore>>;

  beforeAll(async () => {
    server = await startValkeyTestServer();
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "raise-test-"));
    testStore = await createValkeyTestStore(server.url, "closed-loop");
    app = await createValkeyTestApp(testStore.store, {
      dataDir,
      publicBaseUrl: "http://raise.test",
    });
  });

  afterEach(async () => {
    await app.close();
    await testStore.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  });

  afterAll(async () => server?.stop());

  async function create(origin: Role, withImage = false) {
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
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<CreateRaiseResponse>();
  }

  async function exchange(url: string) {
    const raiseId = new URL(url).pathname.split("/").at(-1) as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: { raiseId, token: claimToken(url), mode: "token" },
    });
    expect(response.statusCode).toBe(200);
    const claim = response.json<ClaimResponse>();
    expect(claim.token).toBeTruthy();
    return claim.token as string;
  }

  function auth(token: string) {
    return {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomBytes(18).toString("base64url"),
    };
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

  it("requires an idempotency key and replays the exact entry without duplicating it", async () => {
    const created = await create("human");
    const agentToken = await exchange(created.targetClaimUrl);
    const payload = {
      kind: "result",
      body: "One committed result.",
      attachments: [{ name: "result.png", mimeType: "image/png", dataUrl: onePixelPng }],
      expectedVersion: 1,
    };
    const headers = {
      authorization: `Bearer ${agentToken}`,
      "idempotency-key": "http-exact-replay-0001",
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<RaiseView>()).toMatchObject({ version: 2 });

    const replay = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<RaiseView>()).toMatchObject({ version: 2 });
    expect(replay.json<RaiseView>().entries).toHaveLength(2);
    expect(replay.json<RaiseView>().entries[1]?.attachments).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/raises/${created.raiseId}/entries`,
      headers,
      payload: { ...payload, body: "A different result." },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "idempotency_conflict" });

    const missing = await create("human");
    const missingToken = await exchange(missing.targetClaimUrl);
    const withoutKey = await app.inject({
      method: "POST",
      url: `/api/raises/${missing.raiseId}/entries`,
      headers: { authorization: `Bearer ${missingToken}` },
      payload: { ...payload, attachments: [] },
    });
    expect(withoutKey.statusCode).toBe(400);
    expect(withoutKey.json()).toMatchObject({ code: "invalid_request" });
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
    const mismatchedRequest = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: second.raiseId,
        token: claimToken(first.ownerClaimUrl),
        mode: "token",
      },
    });
    expect(mismatchedRequest.statusCode).toBe(401);
    expect(mismatchedRequest.json()).toMatchObject({ code: "invalid_capability" });

    const firstToken = await exchange(first.ownerClaimUrl);

    const reused = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: first.raiseId,
        token: claimToken(first.ownerClaimUrl),
        mode: "token",
      },
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
        raiseId: created.raiseId,
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
      payload: {
        raiseId: created.raiseId,
        token,
        mode: "token",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(first.statusCode).toBe(200);

    const claimId = token.slice(0, token.indexOf(".")).slice("cap_".length);
    const keys = valkeyRaiseKeys(created.raiseId, testStore.keyPrefix);
    const rawClaim = await testStore.client.hGet(keys.capabilities, claimId);
    const storedClaim = JSON.parse(rawClaim ?? "null") as {
      contentKeyEnvelope: string;
      exchangeDigest: string;
      exchangeMode: string;
      sessionCapabilityId: string;
    };
    expect(rawClaim).not.toContain(exchangeId);
    expect(storedClaim).toMatchObject({
      contentKeyEnvelope: "",
      exchangeDigest: createHash("sha256")
        .update("raise/claim-exchange/v1")
        .update("\0")
        .update(exchangeId)
        .digest("hex"),
      exchangeMode: "token",
    });
    const rawSession = await testStore.client.hGet(
      keys.capabilities,
      storedClaim.sessionCapabilityId,
    );
    expect(JSON.parse(rawSession ?? "null")).toMatchObject({
      kind: "session",
      contentKeyEnvelope: expect.stringMatching(/^wk1\./),
    });

    await app.close();
    await testStore.client.close();
    testStore = await createValkeyTestStore(server.url, "closed-loop-restart", testStore.keyPrefix);
    app = await createValkeyTestApp(testStore.store, {
      dataDir,
      publicBaseUrl: "http://raise.test",
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: created.raiseId,
        token,
        mode: "token",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const [claimPrefix] = token.split(".");
    const forged = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: created.raiseId,
        token: `${claimPrefix}.${"A".repeat(43)}`,
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
        raiseId: created.raiseId,
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
      payload: {
        raiseId: created.raiseId,
        token,
        mode: "cookie",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<ClaimResponse>().token).toBeUndefined();
    expect(first.headers["set-cookie"]).toContain("raise_session_");

    const tokenReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: created.raiseId,
        token,
        mode: "token",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(tokenReplay.statusCode).toBe(401);
    expect(tokenReplay.json()).toMatchObject({ code: "invalid_capability" });

    const cookieReplay = await app.inject({
      method: "POST",
      url: "/api/claims",
      payload: {
        raiseId: created.raiseId,
        token,
        mode: "cookie",
        expectedRole: "agent",
        exchangeId,
      },
    });
    expect(cookieReplay.statusCode).toBe(200);
    expect(cookieReplay.json()).toEqual(first.json());
    expect(cookieReplay.headers["set-cookie"]).toBe(first.headers["set-cookie"]);
  });

  it("stores encrypted image bytes and serves a sanitized image only with Raise access", async () => {
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
    expect(image.headers["cache-control"]).toBe("private, no-store");
    expect(image.headers["content-security-policy"]).not.toContain("localhost");
    expect(image.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");

    const keys = valkeyRaiseKeys(created.raiseId, testStore.keyPrefix);
    const rawAttachment = await testStore.client.hGet(keys.meta, `attachment:${attachment?.id}`);
    const stored = JSON.parse(rawAttachment ?? "null") as { blobKey: string };
    const storedFiles = await readFile(join(dataDir, "blobs", stored.blobKey));
    expect(storedFiles.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
    expect(storedFiles.toString("utf8")).toMatch(/^v1\./);
  });

  it("rejects undocumented preview values and invalid change queries", async () => {
    const created = await create("human", true);
    const humanToken = await exchange(created.ownerClaimUrl);
    const view = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: auth(humanToken),
    });
    const attachment = view.json<RaiseView>().entries[0]?.attachments[0];
    expect(attachment).toBeTruthy();

    const preview = await app.inject({
      method: "GET",
      url: `${attachment?.url}?preview=thumbnail`,
      headers: auth(humanToken),
    });
    expect(preview.statusCode).toBe(400);

    const missingCursor = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes`,
      headers: auth(humanToken),
    });
    expect(missingCursor.statusCode).toBe(400);

    const malformedCursor = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=1.5`,
      headers: auth(humanToken),
    });
    expect(malformedCursor.statusCode).toBe(400);

    const excessiveWait = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=${view.json<RaiseView>().cursor}&wait=31`,
      headers: auth(humanToken),
    });
    expect(excessiveWait.statusCode).toBe(400);
  });

  it("keeps user text, URLs, filenames, and WebP bytes out of raw persistence", async () => {
    const sentinel = "RAISE-PLAINTEXT-SENTINEL-3a1e259f";
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: sentinel,
        url: `https://example.test/${sentinel}`,
        attachments: [{ name: `${sentinel}.png`, mimeType: "image/png", dataUrl: onePixelPng }],
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
      title: sentinel,
      entries: [
        {
          body: sentinel,
          url: `https://example.test/${sentinel}`,
          attachments: [{ name: `${sentinel}.png` }],
        },
      ],
    });

    const attachment = view.json<RaiseView>().entries[0]?.attachments[0];
    const keys = valkeyRaiseKeys(created.raiseId, testStore.keyPrefix);
    const rawTitle = await testStore.client.hGet(keys.meta, "titleEnvelope");
    const rawEntries = await testStore.client.xRange(keys.entries, "-", "+");
    const rawAttachment = await testStore.client.hGet(keys.meta, `attachment:${attachment?.id}`);
    const storedAttachment = JSON.parse(rawAttachment ?? "null") as {
      blobKey: string;
      displayNameEnvelope: string;
    };
    const firstEntry = rawEntries[0]?.message;
    const envelopes = [
      rawTitle,
      firstEntry?.bodyEnvelope,
      firstEntry?.urlEnvelope,
      storedAttachment.displayNameEnvelope,
    ];
    for (const envelope of envelopes) {
      expect(envelope).toMatch(/^v1\./);
      expect(envelope).not.toContain(sentinel);
    }
    expect(JSON.stringify({ rawTitle, rawEntries, rawAttachment })).not.toContain(sentinel);
    const encryptedImage = await readFile(join(dataDir, "blobs", storedAttachment.blobKey));
    expect(encryptedImage.includes(Buffer.from("RIFF", "ascii"))).toBe(false);
    expect(encryptedImage.includes(Buffer.from("WEBP", "ascii"))).toBe(false);
  });

  it("creates a screenshot-only request with a useful title", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: {
        origin: "human",
        prompt: "",
        attachments: [{ name: "billing.png", mimeType: "image/png", dataUrl: onePixelPng }],
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
    app = await createValkeyTestApp(testStore.store, {
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

    expect(await testStore.client.keys(`${testStore.keyPrefix}*`)).toEqual([]);

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
