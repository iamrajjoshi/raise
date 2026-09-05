import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimResponse, CreateRaiseResponse, RaiseView } from "@raise/protocol";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createValkeyTestApp,
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

function claimToken(url: string): string {
  return new URL(url).hash.slice("#token=".length);
}

describe("Raise change reads", () => {
  let app: FastifyInstance;
  let root: string;
  let server: ValkeyTestServer;
  let testStore: Awaited<ReturnType<typeof createValkeyTestStore>>;

  beforeAll(async () => {
    server = await startValkeyTestServer();
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "raise-changes-"));
    testStore = await createValkeyTestStore(server.url, "changes");
    app = await createValkeyTestApp(testStore.store, {
      dataDir: root,
      publicBaseUrl: "http://raise.test",
    });
  });

  afterEach(async () => {
    await app.close();
    await testStore.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => server?.stop());

  async function createAndClaim() {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/raises",
      payload: { origin: "human", prompt: "Check the mobile layout." },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<CreateRaiseResponse>();

    const exchange = async (claimUrl: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/claims",
        payload: {
          raiseId: created.raiseId,
          token: claimToken(claimUrl),
          mode: "token",
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<ClaimResponse>().token as string;
    };

    return {
      created,
      humanToken: await exchange(created.ownerClaimUrl),
      agentToken: await exchange(created.targetClaimUrl),
    };
  }

  function authorization(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function postAgentResult(raiseId: string, token: string, version: number) {
    return app.inject({
      method: "POST",
      url: `/api/raises/${raiseId}/entries`,
      headers: {
        ...authorization(token),
        "idempotency-key": randomBytes(18).toString("base64url"),
      },
      payload: {
        kind: "result",
        body: "The mobile layout is fixed.",
        attachments: [],
        expectedVersion: version,
      },
    });
  }

  it("returns duplicate-free deltas and a replacement snapshot for an unavailable cursor", async () => {
    const { created, humanToken, agentToken } = await createAndClaim();
    const initialResponse = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}`,
      headers: authorization(humanToken),
    });
    const initial = initialResponse.json<RaiseView>();
    expect(initial).toMatchObject({ version: 1, entriesMode: "snapshot" });
    expect(initial.entries).toHaveLength(1);

    const posted = await postAgentResult(created.raiseId, agentToken, 1);
    expect(posted.statusCode).toBe(201);
    const current = posted.json<RaiseView>();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const changed = await app.inject({
        method: "GET",
        url: `/api/raises/${created.raiseId}/changes?cursor=${initial.cursor}`,
        headers: authorization(humanToken),
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json<RaiseView>()).toMatchObject({
        version: 2,
        cursor: current.cursor,
        entriesMode: "delta",
        entries: [{ kind: "result", body: "The mobile layout is fixed." }],
      });
    }

    const unchanged = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=${current.cursor}`,
      headers: authorization(humanToken),
    });
    expect(unchanged.statusCode).toBe(204);

    const replacement = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=0-999999`,
      headers: authorization(humanToken),
    });
    expect(replacement.statusCode).toBe(200);
    expect(replacement.json<RaiseView>()).toMatchObject({
      cursor: current.cursor,
      entriesMode: "snapshot",
    });
    expect(replacement.json<RaiseView>().entries).toHaveLength(2);
  });

  it("wakes a bounded wait after a local write", async () => {
    const { created, humanToken, agentToken } = await createAndClaim();
    const initial = (
      await app.inject({
        method: "GET",
        url: `/api/raises/${created.raiseId}`,
        headers: authorization(humanToken),
      })
    ).json<RaiseView>();

    const waiting = app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=${initial.cursor}&wait=2`,
      headers: authorization(humanToken),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const posted = await postAgentResult(created.raiseId, agentToken, 1);
    expect(posted.statusCode).toBe(201);
    const changed = await waiting;

    expect(changed.statusCode).toBe(200);
    expect(changed.json<RaiseView>()).toMatchObject({
      version: 2,
      entriesMode: "delta",
      entries: [{ kind: "result" }],
    });
  });

  it("returns no content after a clean wait timeout and rejects malformed queries", async () => {
    const { created, humanToken } = await createAndClaim();
    const initial = (
      await app.inject({
        method: "GET",
        url: `/api/raises/${created.raiseId}`,
        headers: authorization(humanToken),
      })
    ).json<RaiseView>();

    const timeout = await app.inject({
      method: "GET",
      url: `/api/raises/${created.raiseId}/changes?cursor=${initial.cursor}&wait=1`,
      headers: authorization(humanToken),
    });
    expect(timeout.statusCode).toBe(204);

    for (const query of ["", "cursor=not-a-cursor", `cursor=${initial.cursor}&wait=31`]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/api/raises/${created.raiseId}/changes?${query}`,
        headers: authorization(humanToken),
      });
      expect(rejected.statusCode).toBe(400);
    }
  });
});
