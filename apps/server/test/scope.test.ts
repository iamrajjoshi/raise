import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createValkeyTestApp,
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

describe("v0.1 manual handoff scope", () => {
  let app: FastifyInstance;
  let dataDir: string;
  let server: ValkeyTestServer;
  let testStore: Awaited<ReturnType<typeof createValkeyTestStore>>;

  beforeAll(async () => {
    server = await startValkeyTestServer();
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "raise-scope-test-"));
    testStore = await createValkeyTestStore(server.url, "scope");
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

  it.each([
    ["GET", "/api/inbox"],
    ["POST", "/api/inbox/r_unknown/session"],
  ] as const)("does not expose the former %s %s route", async (method, url) => {
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(404);
  });
});
