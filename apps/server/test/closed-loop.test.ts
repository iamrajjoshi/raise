import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

describe("Raise closed loop", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "raise-test-"));
    app = await createApp({
      databasePath: join(dataDir, "raise.db"),
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
        title: requestTitle,
        prompt:
          origin === "human"
            ? "Fix the clipped billing empty state."
            : "Which empty state is wrong?",
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
});
