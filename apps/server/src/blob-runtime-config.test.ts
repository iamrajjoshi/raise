import { describe, expect, it } from "vitest";
import { BlobRuntimeConfigurationError, parseBlobRuntimeConfig } from "./blob-runtime-config.js";

describe("parseBlobRuntimeConfig", () => {
  it("defaults to local storage without reading S3-only settings", () => {
    expect(
      parseBlobRuntimeConfig({
        BLOB_S3_ENDPOINT: "not a URL",
        BLOB_S3_ACCESS_KEY_ID: "incomplete",
      }),
    ).toEqual({ driver: "local" });
  });

  it("builds S3 configuration without credentials so the SDK provider chain remains active", () => {
    expect(
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: " private-raise-blobs ",
        BLOB_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        BLOB_S3_FORCE_PATH_STYLE: "false",
        BLOB_S3_ACCESS_KEY_ID: " ",
        BLOB_S3_SECRET_ACCESS_KEY: "",
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
      }),
    ).toEqual({
      driver: "s3",
      bucket: "private-raise-blobs",
      clientConfig: {
        region: "auto",
        endpoint: "https://account.r2.cloudflarestorage.com/",
        forcePathStyle: false,
      },
    });
  });

  it("passes complete explicit S3-compatible credentials", () => {
    expect(
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "raise",
        BLOB_S3_REGION: "us-east-1",
        BLOB_S3_ACCESS_KEY_ID: "access-key",
        BLOB_S3_SECRET_ACCESS_KEY: "secret-key",
        BLOB_S3_SESSION_TOKEN: "session-token",
      }),
    ).toMatchObject({
      clientConfig: {
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
          sessionToken: "session-token",
        },
      },
    });
  });

  it.each([
    [{ BLOB_S3_ACCESS_KEY_ID: "access-key" }, "must be set together"],
    [{ BLOB_S3_SECRET_ACCESS_KEY: "secret-key" }, "must be set together"],
    [{ BLOB_S3_SESSION_TOKEN: "token" }, "requires BLOB_S3_ACCESS_KEY_ID"],
  ])("rejects incomplete explicit credentials", (credentialEnvironment, message) => {
    expect(() =>
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "raise",
        ...credentialEnvironment,
      }),
    ).toThrow(message);
  });

  it.each([undefined, "", "bad bucket", "bucket/path", "bucket\\path"])(
    "rejects a missing or malformed bucket: %s",
    (bucket) => {
      expect(() => parseBlobRuntimeConfig({ BLOB_STORE: "s3", BLOB_S3_BUCKET: bucket })).toThrow(
        BlobRuntimeConfigurationError,
      );
    },
  );

  it.each(["yes", "TRUE", "0"])("rejects a non-boolean path-style value: %s", (value) => {
    expect(() =>
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "raise",
        BLOB_S3_FORCE_PATH_STYLE: value,
      }),
    ).toThrow("BLOB_S3_FORCE_PATH_STYLE must be true or false when set.");
  });

  it.each([
    ["not a URL", "valid URL"],
    ["ftp://objects.example.com", "must use HTTPS"],
    ["http://objects.example.com", "must use HTTPS unless"],
    ["https://user:secret@objects.example.com", "must not contain embedded credentials"],
    ["https://objects.example.com?token=secret", "must not contain a query string"],
    ["https://objects.example.com#bucket", "must not contain a query string"],
  ])("rejects an unsafe endpoint: %s", (endpoint, message) => {
    expect(() =>
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "raise",
        BLOB_S3_ENDPOINT: endpoint,
      }),
    ).toThrow(message);
  });

  it.each([
    "http://localhost:9000",
    "http://minio.localhost:9000",
    "http://127.0.0.1:9000",
    "http://127.25.4.3:9000",
    "http://[::1]:9000",
  ])("allows HTTP only for a loopback development endpoint: %s", (endpoint) => {
    expect(
      parseBlobRuntimeConfig({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "raise",
        BLOB_S3_ENDPOINT: endpoint,
      }),
    ).toMatchObject({ clientConfig: { endpoint: `${endpoint}/` } });
  });

  it("rejects unsupported blob drivers", () => {
    expect(() => parseBlobRuntimeConfig({ BLOB_STORE: "filesystem" })).toThrow(
      "BLOB_STORE must be either local or s3.",
    );
  });
});
