import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const localDataDir = fileURLToPath(new URL("../../../data", import.meta.url));
const dataDir = resolve(process.env.DATA_DIR ?? localDataDir);
const databasePath = resolve(dataDir, "raise.db");
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const inboxToken = process.env.RAISE_INBOX_TOKEN || undefined;

const app = await createApp({
  databasePath,
  dataDir,
  publicBaseUrl,
  logger: true,
  ...(inboxToken ? { inboxToken } : {}),
});

const stop = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port, host: "0.0.0.0" });
