import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import type { Role } from "@raise/protocol";
import type { CapabilityKind } from "./capabilities.js";

const AES_ALGORITHM = "aes-256-gcm";
const CONTENT_ENVELOPE_PREFIX = "v1";
const WRAPPED_KEY_ENVELOPE_PREFIX = "wk1";
const CONTENT_CONTEXT_DOMAIN = "raise/content/v1";
const WRAP_CONTEXT_DOMAIN = "raise/content-key-wrap/v1";

export const CONTENT_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const CAPABILITY_SALT_BYTES = 32;
const MIN_CAPABILITY_SECRET_BYTES = 16;

const MAX_CONTEXT_COMPONENT_BYTES = 1_024;
const MAX_CAPABILITY_SECRET_BYTES = 1_024;

export interface AuthenticatedContentContext {
  requestId: string;
  recordType: string;
  recordId: string;
  field: string;
  authorRole?: Role;
}

export interface ContentKeyWrapContext {
  requestId: string;
  capabilityId: string;
  role: Role;
  purpose: CapabilityKind;
}

export interface SealContentInput {
  plaintext: Uint8Array;
  contentKey: Uint8Array;
  context: AuthenticatedContentContext;
}

export interface OpenContentInput {
  envelope: string;
  contentKey: Uint8Array;
  context: AuthenticatedContentContext;
}

export interface SealTextInput {
  plaintext: string;
  contentKey: Uint8Array;
  context: AuthenticatedContentContext;
}

export type OpenTextInput = OpenContentInput;

export interface WrapContentKeyInput {
  contentKey: Uint8Array;
  capabilitySecret: Uint8Array;
  context: ContentKeyWrapContext;
}

export interface UnwrapContentKeyInput {
  envelope: string;
  capabilitySecret: Uint8Array;
  context: ContentKeyWrapContext;
}

type ContentCryptoErrorCode = "invalid_input" | "invalid_envelope" | "authentication_failed";

export class ContentCryptoError extends Error {
  readonly code: ContentCryptoErrorCode;

  constructor(code: ContentCryptoErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContentCryptoError";
    this.code = code;
  }
}

interface EncryptedParts {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

interface WrappedKeyParts extends EncryptedParts {
  salt: Buffer;
}

function invalidInput(message: string): never {
  throw new ContentCryptoError("invalid_input", message);
}

function invalidEnvelope(message: string): never {
  throw new ContentCryptoError("invalid_envelope", message);
}

function copyBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array)) invalidInput(`${label} must be bytes.`);
  return Buffer.from(value);
}

function exactBytes(value: Uint8Array, expectedLength: number, label: string): Buffer {
  const bytes = copyBytes(value, label);
  if (bytes.length !== expectedLength) {
    bytes.fill(0);
    invalidInput(`${label} must be exactly ${expectedLength} bytes.`);
  }
  return bytes;
}

function capabilitySecretBytes(value: Uint8Array): Buffer {
  const bytes = copyBytes(value, "Capability secret");
  if (bytes.length < MIN_CAPABILITY_SECRET_BYTES) {
    bytes.fill(0);
    invalidInput(`Capability secret must contain at least ${MIN_CAPABILITY_SECRET_BYTES} bytes.`);
  }
  if (bytes.length > MAX_CAPABILITY_SECRET_BYTES) {
    bytes.fill(0);
    invalidInput(`Capability secret must not exceed ${MAX_CAPABILITY_SECRET_BYTES} bytes.`);
  }
  return bytes;
}

function checkedContextComponent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidInput(`${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONTEXT_COMPONENT_BYTES) {
    invalidInput(`${label} must not exceed ${MAX_CONTEXT_COMPONENT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function checkedRole(value: unknown, label: string): Role {
  if (value !== "human" && value !== "agent") {
    invalidInput(`${label} must be human or agent.`);
  }
  return value;
}

function encodeAuthenticatedContentContext(context: AuthenticatedContentContext): Buffer {
  if (!context || typeof context !== "object") invalidInput("Content context is required.");

  const requestId = checkedContextComponent(context.requestId, "Content context requestId");
  const recordType = checkedContextComponent(context.recordType, "Content context recordType");
  const recordId = checkedContextComponent(context.recordId, "Content context recordId");
  const field = checkedContextComponent(context.field, "Content context field");
  const authorRole =
    context.authorRole === undefined
      ? null
      : checkedRole(context.authorRole, "Content context authorRole");

  return Buffer.from(
    JSON.stringify([CONTENT_CONTEXT_DOMAIN, requestId, recordType, recordId, field, authorRole]),
    "utf8",
  );
}

function encodeContentKeyWrapContext(context: ContentKeyWrapContext): Buffer {
  if (!context || typeof context !== "object")
    invalidInput("Content-key wrap context is required.");

  const requestId = checkedContextComponent(context.requestId, "Wrap context requestId");
  const capabilityId = checkedContextComponent(context.capabilityId, "Wrap context capabilityId");
  const role = checkedRole(context.role, "Wrap context role");
  if (context.purpose !== "claim" && context.purpose !== "session") {
    invalidInput("Wrap context purpose must be claim or session.");
  }

  return Buffer.from(
    JSON.stringify([WRAP_CONTEXT_DOMAIN, requestId, capabilityId, role, context.purpose]),
    "utf8",
  );
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    invalidEnvelope(`${label} is not canonical base64url.`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    invalidEnvelope(`${label} is not canonical base64url.`);
  }
  return bytes;
}

function parseContentEnvelope(envelope: string): EncryptedParts {
  if (typeof envelope !== "string") invalidEnvelope("Encrypted content must be a string.");
  const [prefix, encodedNonce, encodedCiphertext, encodedTag, extra] = envelope.split(".");
  if (
    prefix !== CONTENT_ENVELOPE_PREFIX ||
    encodedNonce === undefined ||
    encodedCiphertext === undefined ||
    encodedTag === undefined ||
    extra !== undefined
  ) {
    invalidEnvelope("Encrypted content has an unsupported envelope format.");
  }

  const nonce = decodeBase64Url(encodedNonce, "Content nonce");
  const ciphertext = decodeBase64Url(encodedCiphertext, "Content ciphertext");
  const tag = decodeBase64Url(encodedTag, "Content authentication tag");
  if (nonce.length !== GCM_NONCE_BYTES) invalidEnvelope("Content nonce has an invalid length.");
  if (tag.length !== GCM_TAG_BYTES) {
    invalidEnvelope("Content authentication tag has an invalid length.");
  }

  return { nonce, ciphertext, tag };
}

function parseWrappedKeyEnvelope(envelope: string): WrappedKeyParts {
  if (typeof envelope !== "string") invalidEnvelope("Wrapped content key must be a string.");
  const [prefix, encodedSalt, encodedNonce, encodedCiphertext, encodedTag, extra] =
    envelope.split(".");
  if (
    prefix !== WRAPPED_KEY_ENVELOPE_PREFIX ||
    encodedSalt === undefined ||
    encodedNonce === undefined ||
    encodedCiphertext === undefined ||
    encodedTag === undefined ||
    extra !== undefined
  ) {
    invalidEnvelope("Wrapped content key has an unsupported envelope format.");
  }

  const salt = decodeBase64Url(encodedSalt, "Capability salt");
  const nonce = decodeBase64Url(encodedNonce, "Wrapped-key nonce");
  const ciphertext = decodeBase64Url(encodedCiphertext, "Wrapped key");
  const tag = decodeBase64Url(encodedTag, "Wrapped-key authentication tag");
  if (salt.length !== CAPABILITY_SALT_BYTES) {
    invalidEnvelope("Capability salt has an invalid length.");
  }
  if (nonce.length !== GCM_NONCE_BYTES) invalidEnvelope("Wrapped-key nonce has an invalid length.");
  if (ciphertext.length !== CONTENT_KEY_BYTES)
    invalidEnvelope("Wrapped key has an invalid length.");
  if (tag.length !== GCM_TAG_BYTES) {
    invalidEnvelope("Wrapped-key authentication tag has an invalid length.");
  }

  return { salt, nonce, ciphertext, tag };
}

function seal(plaintext: Uint8Array, key: Buffer, authenticatedData: Buffer): EncryptedParts {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(authenticatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function open(parts: EncryptedParts, key: Buffer, authenticatedData: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(AES_ALGORITHM, key, parts.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(authenticatedData);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  } catch (cause) {
    throw new ContentCryptoError(
      "authentication_failed",
      "Encrypted content could not be authenticated.",
      { cause },
    );
  }
}

function serializeContentEnvelope(parts: EncryptedParts): string {
  return [
    CONTENT_ENVELOPE_PREFIX,
    parts.nonce.toString("base64url"),
    parts.ciphertext.toString("base64url"),
    parts.tag.toString("base64url"),
  ].join(".");
}

function deriveWrappingKey(
  capabilitySecret: Buffer,
  salt: Buffer,
  authenticatedContext: Buffer,
): Buffer {
  return Buffer.from(
    hkdfSync("sha256", capabilitySecret, salt, authenticatedContext, CONTENT_KEY_BYTES),
  );
}

export function generateContentKey(): Buffer {
  return randomBytes(CONTENT_KEY_BYTES);
}

export function sealContent(input: SealContentInput): string {
  const authenticatedContext = encodeAuthenticatedContentContext(input.context);
  const key = exactBytes(input.contentKey, CONTENT_KEY_BYTES, "Content key");
  try {
    const plaintext = copyBytes(input.plaintext, "Plaintext");
    try {
      return serializeContentEnvelope(seal(plaintext, key, authenticatedContext));
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
    authenticatedContext.fill(0);
  }
}

export function openContent(input: OpenContentInput): Buffer {
  const parts = parseContentEnvelope(input.envelope);
  const authenticatedContext = encodeAuthenticatedContentContext(input.context);
  const key = exactBytes(input.contentKey, CONTENT_KEY_BYTES, "Content key");
  try {
    return open(parts, key, authenticatedContext);
  } finally {
    key.fill(0);
    authenticatedContext.fill(0);
  }
}

export function sealText(input: SealTextInput): string {
  if (typeof input.plaintext !== "string") invalidInput("Plaintext must be a string.");
  const plaintext = Buffer.from(input.plaintext, "utf8");
  try {
    return sealContent({ plaintext, contentKey: input.contentKey, context: input.context });
  } finally {
    plaintext.fill(0);
  }
}

export function openText(input: OpenTextInput): string {
  const plaintext = openContent(input);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (cause) {
    throw new ContentCryptoError("invalid_envelope", "Decrypted text is not valid UTF-8.", {
      cause,
    });
  } finally {
    plaintext.fill(0);
  }
}

export function wrapContentKey(input: WrapContentKeyInput): string {
  const authenticatedContext = encodeContentKeyWrapContext(input.context);
  const contentKey = exactBytes(input.contentKey, CONTENT_KEY_BYTES, "Content key");
  try {
    const capabilitySecret = capabilitySecretBytes(input.capabilitySecret);
    const salt = randomBytes(CAPABILITY_SALT_BYTES);
    const wrappingKey = deriveWrappingKey(capabilitySecret, salt, authenticatedContext);
    try {
      const parts = seal(contentKey, wrappingKey, authenticatedContext);
      return [
        WRAPPED_KEY_ENVELOPE_PREFIX,
        salt.toString("base64url"),
        parts.nonce.toString("base64url"),
        parts.ciphertext.toString("base64url"),
        parts.tag.toString("base64url"),
      ].join(".");
    } finally {
      capabilitySecret.fill(0);
      wrappingKey.fill(0);
    }
  } finally {
    contentKey.fill(0);
    authenticatedContext.fill(0);
  }
}

export function unwrapContentKey(input: UnwrapContentKeyInput): Buffer {
  const parts = parseWrappedKeyEnvelope(input.envelope);
  const authenticatedContext = encodeContentKeyWrapContext(input.context);
  const capabilitySecret = capabilitySecretBytes(input.capabilitySecret);
  const wrappingKey = deriveWrappingKey(capabilitySecret, parts.salt, authenticatedContext);
  try {
    const contentKey = open(parts, wrappingKey, authenticatedContext);
    if (contentKey.length !== CONTENT_KEY_BYTES) {
      contentKey.fill(0);
      invalidEnvelope("Unwrapped content key has an invalid length.");
    }
    return contentKey;
  } finally {
    capabilitySecret.fill(0);
    wrappingKey.fill(0);
    authenticatedContext.fill(0);
  }
}
