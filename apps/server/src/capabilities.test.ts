import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DIGEST_BYTES,
  CAPABILITY_ID_BYTES,
  CAPABILITY_SECRET_BYTES,
  createCapability,
  deriveExchangeSessionSecret,
  digestCapabilitySecret,
  encodeCapabilityToken,
  generateCapabilityId,
  generateCapabilitySecret,
  parseCapabilityToken,
  verifyCapabilitySecretDigest,
} from "./capabilities.js";

describe("capability tokens", () => {
  it.each(["claim", "session"] as const)("round trips a %s capability", (kind) => {
    const created = createCapability(kind);
    const parsed = parseCapabilityToken(created.token, kind);

    expect(Buffer.from(created.id, "base64url")).toHaveLength(CAPABILITY_ID_BYTES);
    expect(created.secret).toHaveLength(CAPABILITY_SECRET_BYTES);
    expect(created.secretDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.id).toBe(created.id);
    expect(parsed.secret).toEqual(created.secret);
    expect(created.token).toBe(encodeCapabilityToken(kind, created.id, created.secret));
  });

  it("generates independent IDs and secrets", () => {
    const first = createCapability("claim");
    const second = createCapability("claim");

    expect(second.id).not.toBe(first.id);
    expect(second.secret).not.toEqual(first.secret);
    expect(second.token).not.toBe(first.token);
  });

  it("generates canonical ID and secret components", () => {
    const id = generateCapabilityId();
    const secret = generateCapabilitySecret();

    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(id, "base64url").toString("base64url")).toBe(id);
    expect(secret).toHaveLength(CAPABILITY_SECRET_BYTES);
  });

  it("rejects a token for the wrong capability kind", () => {
    const claim = createCapability("claim");

    expect(() => parseCapabilityToken(claim.token, "session")).toThrowError(
      expect.objectContaining({
        statusCode: 401,
        code: "invalid_capability",
        message: "This link doesn’t work.",
      }),
    );
  });

  it.each([
    "",
    "cap_short.secret",
    "cap_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "cap_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
    "cap_AAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "CAP_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    " cap_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "cap_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
  ])("rejects malformed or weak input without echoing it: %j", (token) => {
    let thrown: unknown;
    try {
      parseCapabilityToken(token, "claim");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ statusCode: 401, code: "invalid_capability" });
    expect(String(thrown)).not.toContain(token || "never-matches-empty-input");
  });

  it("rejects a noncanonical base64url secret", () => {
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const noncanonicalSecret = `${"A".repeat(42)}B`;

    expect(() => parseCapabilityToken(`cap_${id}.${noncanonicalSecret}`, "claim")).toThrowError(
      expect.objectContaining({ code: "invalid_capability" }),
    );
  });

  it("rejects weak raw secrets and IDs when encoding", () => {
    expect(() => encodeCapabilityToken("claim", "too-short", Buffer.alloc(32))).toThrow(
      "Capability ID must be",
    );
    expect(() => encodeCapabilityToken("claim", generateCapabilityId(), Buffer.alloc(31))).toThrow(
      "Capability secret must be exactly 32 bytes.",
    );
  });
});

describe("capability secret digests", () => {
  it("produces a fixed-length digest and verifies it", () => {
    const capability = createCapability("session");
    const digest = digestCapabilitySecret("session", capability.id, capability.secret);

    expect(Buffer.from(digest, "hex")).toHaveLength(CAPABILITY_DIGEST_BYTES);
    expect(verifyCapabilitySecretDigest(digest, "session", capability.id, capability.secret)).toBe(
      true,
    );
  });

  it("binds the digest to the kind, ID, and secret", () => {
    const id = generateCapabilityId();
    const otherId = generateCapabilityId();
    const secret = generateCapabilitySecret();
    const otherSecret = generateCapabilitySecret();
    const digest = digestCapabilitySecret("claim", id, secret);

    expect(digestCapabilitySecret("session", id, secret)).not.toBe(digest);
    expect(digestCapabilitySecret("claim", otherId, secret)).not.toBe(digest);
    expect(digestCapabilitySecret("claim", id, otherSecret)).not.toBe(digest);
  });

  it("returns false for mismatched and malformed stored digests", () => {
    const capability = createCapability("session");

    expect(
      verifyCapabilitySecretDigest("0".repeat(64), "session", capability.id, capability.secret),
    ).toBe(false);
    expect(
      verifyCapabilitySecretDigest("not-a-digest", "session", capability.id, capability.secret),
    ).toBe(false);
  });
});

describe("claim exchange session secrets", () => {
  it("derives the same 32-byte secret for an exact retry", () => {
    const claimSecret = generateCapabilitySecret();
    const sessionId = generateCapabilityId();
    const exchangeId = "7b32c27a-6f2d-4fd2-9be4-6fded48ce104";

    const first = deriveExchangeSessionSecret(claimSecret, exchangeId, sessionId);
    const retry = deriveExchangeSessionSecret(claimSecret, exchangeId, sessionId);

    expect(first).toHaveLength(CAPABILITY_SECRET_BYTES);
    expect(retry).toEqual(first);
  });

  it("changes when the claim secret, exchange ID, or session ID changes", () => {
    const claimSecret = generateCapabilitySecret();
    const exchangeId = "7b32c27a-6f2d-4fd2-9be4-6fded48ce104";
    const sessionId = generateCapabilityId();
    const baseline = deriveExchangeSessionSecret(claimSecret, exchangeId, sessionId);

    expect(
      deriveExchangeSessionSecret(generateCapabilitySecret(), exchangeId, sessionId),
    ).not.toEqual(baseline);
    expect(deriveExchangeSessionSecret(claimSecret, `${exchangeId}x`, sessionId)).not.toEqual(
      baseline,
    );
    expect(
      deriveExchangeSessionSecret(claimSecret, exchangeId, generateCapabilityId()),
    ).not.toEqual(baseline);
  });

  it("rejects weak claim secrets, exchange IDs, and session IDs", () => {
    const claimSecret = generateCapabilitySecret();
    const sessionId = generateCapabilityId();

    expect(() => deriveExchangeSessionSecret(Buffer.alloc(31), "A".repeat(16), sessionId)).toThrow(
      "Capability secret must be exactly 32 bytes.",
    );
    expect(() => deriveExchangeSessionSecret(claimSecret, "too-short", sessionId)).toThrow(
      "Exchange ID must be",
    );
    expect(() => deriveExchangeSessionSecret(claimSecret, "A".repeat(16), "too-short")).toThrow(
      "Capability ID must be",
    );
  });
});
