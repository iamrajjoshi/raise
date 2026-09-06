import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.js";

const CLAIM_PREFIX = "cap";
const SESSION_PREFIX = "ses";
const CAPABILITY_DIGEST_DOMAIN = "raise/capability-secret/v1";
const CLAIM_EXCHANGE_DOMAIN = "raise-claim-exchange-v1";
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CAPABILITY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXCHANGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const CAPABILITY_ID_BYTES = 16;
export const CAPABILITY_SECRET_BYTES = 32;
export const CAPABILITY_DIGEST_BYTES = 32;

export function isSha256HexDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

export type CapabilityKind = "claim" | "session";

export interface ParsedCapability {
  id: string;
  secret: Buffer;
}

export interface CreatedCapability extends ParsedCapability {
  kind: CapabilityKind;
  token: string;
  secretDigest: string;
}

function invalidCapability(): never {
  throw new HttpError(401, "invalid_capability", "This link doesn’t work.");
}

function prefixFor(kind: CapabilityKind): typeof CLAIM_PREFIX | typeof SESSION_PREFIX {
  return kind === "claim" ? CLAIM_PREFIX : SESSION_PREFIX;
}

function assertKind(kind: unknown): asserts kind is CapabilityKind {
  if (kind !== "claim" && kind !== "session") {
    throw new TypeError("Capability kind must be claim or session.");
  }
}

function isCanonicalBase64Url(value: string, byteLength: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === byteLength && decoded.toString("base64url") === value;
}

function assertCapabilityId(capabilityId: string): void {
  if (
    typeof capabilityId !== "string" ||
    !CAPABILITY_ID_PATTERN.test(capabilityId) ||
    !isCanonicalBase64Url(capabilityId, CAPABILITY_ID_BYTES)
  ) {
    throw new TypeError("Capability ID must be a canonical 128-bit base64url value.");
  }
}

function capabilitySecret(secret: Uint8Array): Buffer {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== CAPABILITY_SECRET_BYTES) {
    throw new TypeError("Capability secret must be exactly 32 bytes.");
  }
  return Buffer.from(secret);
}

export function generateCapabilityId(): string {
  return randomBytes(CAPABILITY_ID_BYTES).toString("base64url");
}

export function generateCapabilitySecret(): Buffer {
  return randomBytes(CAPABILITY_SECRET_BYTES);
}

export function encodeCapabilityToken(
  kind: CapabilityKind,
  capabilityId: string,
  secret: Uint8Array,
): string {
  assertKind(kind);
  assertCapabilityId(capabilityId);
  const secretBytes = capabilitySecret(secret);
  try {
    return `${prefixFor(kind)}_${capabilityId}.${secretBytes.toString("base64url")}`;
  } finally {
    secretBytes.fill(0);
  }
}

export function parseCapabilityToken(
  token: string,
  expectedKind: CapabilityKind,
): ParsedCapability {
  assertKind(expectedKind);
  if (typeof token !== "string") invalidCapability();

  const match = /^(cap|ses)_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
  const prefix = match?.[1];
  const capabilityId = match?.[2];
  const encodedSecret = match?.[3];
  if (
    prefix !== prefixFor(expectedKind) ||
    capabilityId === undefined ||
    encodedSecret === undefined
  ) {
    invalidCapability();
  }

  if (
    !CAPABILITY_ID_PATTERN.test(capabilityId) ||
    !CAPABILITY_SECRET_PATTERN.test(encodedSecret) ||
    !isCanonicalBase64Url(capabilityId, CAPABILITY_ID_BYTES) ||
    !isCanonicalBase64Url(encodedSecret, CAPABILITY_SECRET_BYTES)
  ) {
    invalidCapability();
  }

  return {
    id: capabilityId,
    secret: Buffer.from(encodedSecret, "base64url"),
  };
}

export function digestCapabilitySecret(
  kind: CapabilityKind,
  capabilityId: string,
  secret: Uint8Array,
): string {
  assertKind(kind);
  assertCapabilityId(capabilityId);
  const secretBytes = capabilitySecret(secret);
  try {
    return createHash("sha256")
      .update(CAPABILITY_DIGEST_DOMAIN)
      .update("\0")
      .update(kind)
      .update("\0")
      .update(capabilityId)
      .update("\0")
      .update(secretBytes)
      .digest("hex");
  } finally {
    secretBytes.fill(0);
  }
}

export function verifyCapabilitySecretDigest(
  expectedDigest: string,
  kind: CapabilityKind,
  capabilityId: string,
  secret: Uint8Array,
): boolean {
  const actual = Buffer.from(digestCapabilitySecret(kind, capabilityId, secret), "hex");
  const expectedIsValid = isSha256HexDigest(expectedDigest);
  const expected = expectedIsValid
    ? Buffer.from(expectedDigest, "hex")
    : Buffer.alloc(CAPABILITY_DIGEST_BYTES);
  return timingSafeEqual(actual, expected) && expectedIsValid;
}

export function deriveExchangeSessionSecret(
  claimSecret: Uint8Array,
  exchangeId: string,
  sessionCapabilityId: string,
): Buffer {
  const claimSecretBytes = capabilitySecret(claimSecret);
  try {
    if (typeof exchangeId !== "string" || !EXCHANGE_ID_PATTERN.test(exchangeId)) {
      throw new TypeError(
        "Exchange ID must be a canonical base64url value between 16 and 100 characters.",
      );
    }
    assertCapabilityId(sessionCapabilityId);
    return createHmac("sha256", claimSecretBytes)
      .update(CLAIM_EXCHANGE_DOMAIN)
      .update("\0")
      .update(exchangeId)
      .update("\0")
      .update(sessionCapabilityId)
      .digest();
  } finally {
    claimSecretBytes.fill(0);
  }
}

export function createCapability(kind: CapabilityKind): CreatedCapability {
  assertKind(kind);
  const id = generateCapabilityId();
  const secret = generateCapabilitySecret();
  return {
    kind,
    id,
    secret,
    token: encodeCapabilityToken(kind, id, secret),
    secretDigest: digestCapabilitySecret(kind, id, secret),
  };
}
