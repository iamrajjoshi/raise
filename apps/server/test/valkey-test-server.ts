import { createClient } from "@redis/client";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createApp, type AppOptions } from "../src/app.js";
import { LocalBlobStore } from "../src/blob-store.js";
import { ValkeyRaiseStore } from "../src/valkey-store.js";

const SERVER_CANDIDATES = [
  "/opt/homebrew/bin/valkey-server",
  "/opt/homebrew/opt/valkey/bin/valkey-server",
  "/home/linuxbrew/.linuxbrew/opt/valkey/bin/valkey-server",
  "/usr/local/bin/valkey-server",
  "/usr/bin/valkey-server",
  "/opt/homebrew/bin/redis-server",
  "/usr/local/bin/redis-server",
  "/usr/bin/redis-server",
];

export interface ValkeyTestServer {
  url: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a port for the Valkey test server.");
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitUntilReady(url: string, child?: ChildProcess): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child && child.exitCode !== null) {
      throw new Error(`The Valkey test server exited before becoming ready (${child.exitCode}).`);
    }
    const client = createClient({ url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.ping();
      await client.close();
      return;
    } catch (error) {
      lastError = error;
      client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Could not connect to the Valkey test server at ${url}.`, { cause: lastError });
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    setTimeout(resolve, 1_000).unref();
  });
}

export async function startValkeyTestServer(): Promise<ValkeyTestServer> {
  const externalUrl = process.env.VALKEY_TEST_URL?.trim();
  if (externalUrl) {
    await waitUntilReady(externalUrl);
    return { url: externalUrl, stop: async () => undefined };
  }

  const configuredBinary = process.env.VALKEY_SERVER_BIN?.trim();
  const binary = configuredBinary ?? SERVER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!binary || !existsSync(binary)) {
    throw new Error(
      "Valkey integration tests require VALKEY_TEST_URL or a local valkey-server/redis-server binary.",
    );
  }

  const port = await freePort();
  const url = `redis://127.0.0.1:${port}`;
  const child = spawn(
    binary,
    ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" },
  );
  child.on("error", () => undefined);
  try {
    await waitUntilReady(url, child);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
  return { url, stop: () => stopProcess(child) };
}

export async function createValkeyTestStore(
  serverUrl: string,
  label = "store",
  keyPrefix = `raise-test:${label}:${crypto.randomUUID()}:`,
) {
  const client = createClient({ url: serverUrl, disableOfflineQueue: true });
  client.on("error", () => undefined);
  await client.connect();
  const store = new ValkeyRaiseStore(client, { keyPrefix, closeClient: false });

  return {
    client,
    keyPrefix,
    store,
    async cleanup() {
      const cleanupClient = client.isOpen
        ? client
        : createClient({ url: serverUrl, disableOfflineQueue: true });
      cleanupClient.on("error", () => undefined);
      if (!cleanupClient.isOpen) await cleanupClient.connect();
      for await (const keys of cleanupClient.scanIterator({
        MATCH: `${keyPrefix}*`,
        COUNT: 100,
      })) {
        if (keys.length > 0) await cleanupClient.unlink(keys);
      }
      await cleanupClient.close();
    },
  };
}

export async function createValkeyTestApp(
  store: ValkeyRaiseStore,
  options: AppOptions & { dataDir: string },
) {
  const blobs = new LocalBlobStore(join(options.dataDir, "blobs"));
  await blobs.start();
  return createApp(options, { raises: store, blobs });
}
