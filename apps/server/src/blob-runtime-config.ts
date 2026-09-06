import { isLoopbackHostname } from "@raise/protocol";
import type { RuntimeBlobConfig } from "./runtime.js";

type RuntimeEnvironment = Record<string, string | undefined>;

export class BlobRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobRuntimeConfigurationError";
  }
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  const configured = optionalValue(value);
  if (configured === undefined) return undefined;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new BlobRuntimeConfigurationError(`${name} must be true or false when set.`);
}

function parseEndpoint(value: string | undefined): string | undefined {
  const configured = optionalValue(value);
  if (configured === undefined) return undefined;

  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new BlobRuntimeConfigurationError("BLOB_S3_ENDPOINT must be a valid URL.");
  }

  if (endpoint.username || endpoint.password) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_ENDPOINT must not contain embedded credentials.",
    );
  }
  if (endpoint.search || endpoint.hash) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_ENDPOINT must not contain a query string or fragment.",
    );
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new BlobRuntimeConfigurationError("BLOB_S3_ENDPOINT must use HTTPS.");
  }
  if (endpoint.protocol === "http:" && !isLoopbackHostname(endpoint.hostname)) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_ENDPOINT must use HTTPS unless it points to localhost or a loopback address.",
    );
  }

  return endpoint.toString();
}

function parseBucket(value: string | undefined): string {
  const bucket = optionalValue(value);
  if (!bucket) {
    throw new BlobRuntimeConfigurationError("BLOB_S3_BUCKET is required when BLOB_STORE=s3.");
  }
  if (bucket.length > 255 || /[\s/\\]/u.test(bucket)) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_BUCKET must be a single bucket name without whitespace or slashes.",
    );
  }
  return bucket;
}

function parseCredentials(environment: RuntimeEnvironment) {
  const accessKeyId = optionalValue(environment.BLOB_S3_ACCESS_KEY_ID);
  const secretAccessKey = optionalValue(environment.BLOB_S3_SECRET_ACCESS_KEY);
  const sessionToken = optionalValue(environment.BLOB_S3_SESSION_TOKEN);

  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_ACCESS_KEY_ID and BLOB_S3_SECRET_ACCESS_KEY must be set together.",
    );
  }
  if (sessionToken && !accessKeyId) {
    throw new BlobRuntimeConfigurationError(
      "BLOB_S3_SESSION_TOKEN requires BLOB_S3_ACCESS_KEY_ID and BLOB_S3_SECRET_ACCESS_KEY.",
    );
  }
  if (!accessKeyId || !secretAccessKey) return undefined;

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export function parseBlobRuntimeConfig(environment: RuntimeEnvironment): RuntimeBlobConfig {
  const driver = optionalValue(environment.BLOB_STORE) ?? "local";
  if (driver === "local") return { driver: "local" };
  if (driver !== "s3") {
    throw new BlobRuntimeConfigurationError("BLOB_STORE must be either local or s3.");
  }

  const endpoint = parseEndpoint(environment.BLOB_S3_ENDPOINT);
  const forcePathStyle = parseBoolean(
    "BLOB_S3_FORCE_PATH_STYLE",
    environment.BLOB_S3_FORCE_PATH_STYLE,
  );
  const credentials = parseCredentials(environment);

  return {
    driver: "s3",
    bucket: parseBucket(environment.BLOB_S3_BUCKET),
    clientConfig: {
      region: optionalValue(environment.BLOB_S3_REGION) ?? "auto",
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
      ...(credentials ? { credentials } : {}),
    },
  };
}
