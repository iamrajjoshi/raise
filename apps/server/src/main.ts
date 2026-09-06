import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobRuntimeConfigurationError, parseBlobRuntimeConfig } from "./blob-runtime-config.js";
import { createRuntimeApp } from "./runtime.js";

const port = Number(process.env.PORT ?? 8787);
const localDataDir = fileURLToPath(new URL("../../../data", import.meta.url));
const dataDir = resolve(process.env.DATA_DIR ?? localDataDir);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const valkeyUrl = process.env.VALKEY_URL?.trim();

if (!valkeyUrl) {
  console.error("Raise requires VALKEY_URL. For local use, run `docker compose up --build`.");
  process.exit(1);
}

function loadBlobRuntimeConfig() {
  try {
    return parseBlobRuntimeConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof BlobRuntimeConfigurationError
        ? error.message
        : "Raise could not read its blob storage configuration.",
    );
    process.exit(1);
  }
}

const app = await createRuntimeApp({
  dataDir,
  publicBaseUrl,
  logger: true,
  valkeyUrl,
  blob: loadBlobRuntimeConfig(),
}).catch((_error: unknown) => {
  // Startup errors can contain connection URLs or provider credentials.
  console.error("Raise could not start because its required storage is unavailable.");
  process.exit(1);
});

const stop = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port, host: "0.0.0.0" });
