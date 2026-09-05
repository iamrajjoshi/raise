import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SALT_BYTES,
  CONTENT_KEY_BYTES,
  ContentCryptoError,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
  generateContentKey,
  openContent,
  openText,
  sealContent,
  sealText,
  unwrapContentKey,
  wrapContentKey,
  type AuthenticatedContentContext,
  type ContentKeyWrapContext,
} from "./content-crypto.js";

const contentContext: AuthenticatedContentContext = {
  requestId: "r_alpha",
  recordType: "entry",
  recordId: "e_first",
  field: "body",
  authorRole: "human",
};

const wrapContext: ContentKeyWrapContext = {
  requestId: "r_alpha",
  capabilityId: "c_human_claim",
  role: "human",
  purpose: "claim",
};

function replaceComponent(envelope: string, index: number, bytes: Uint8Array): string {
  const components = envelope.split(".");
  components[index] = Buffer.from(bytes).toString("base64url");
  return components.join(".");
}

function flipComponent(envelope: string, index: number): string {
  const components = envelope.split(".");
  const bytes = Buffer.from(components[index] as string, "base64url");
  bytes[0] = (bytes[0] as number) ^ 1;
  components[index] = bytes.toString("base64url");
  return components.join(".");
}

describe("content encryption", () => {
  it("generates independent 256-bit content keys", () => {
    const first = generateContentKey();
    const second = generateContentKey();

    expect(first).toHaveLength(CONTENT_KEY_BYTES);
    expect(second).toHaveLength(CONTENT_KEY_BYTES);
    expect(first.equals(second)).toBe(false);
  });

  it("round-trips Unicode text", () => {
    const contentKey = generateContentKey();
    const plaintext = "Header clips at 320 px — José 📷";
    const envelope = sealText({ plaintext, contentKey, context: contentContext });

    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(openText({ envelope, contentKey, context: contentContext })).toBe(plaintext);
  });

  it("round-trips arbitrary binary content", () => {
    const contentKey = generateContentKey();
    const plaintext = Buffer.from([0, 255, 17, 0, 82, 73, 70, 70, 128, 1]);
    const envelope = sealContent({ plaintext, contentKey, context: contentContext });

    expect(openContent({ envelope, contentKey, context: contentContext })).toEqual(plaintext);
  });

  it("supports authenticated empty content", () => {
    const contentKey = generateContentKey();
    const envelope = sealContent({
      plaintext: new Uint8Array(),
      contentKey,
      context: contentContext,
    });

    expect(envelope.split(".")[2]).toBe("");
    expect(openContent({ envelope, contentKey, context: contentContext })).toEqual(Buffer.alloc(0));
  });

  it("rejects a wrong key and altered nonce, ciphertext, or tag", () => {
    const contentKey = generateContentKey();
    const envelope = sealText({ plaintext: "private", contentKey, context: contentContext });

    expect(() =>
      openText({ envelope, contentKey: generateContentKey(), context: contentContext }),
    ).toThrow(ContentCryptoError);
    for (const component of [1, 2, 3]) {
      expect(() =>
        openText({
          envelope: flipComponent(envelope, component),
          contentKey,
          context: contentContext,
        }),
      ).toThrow(ContentCryptoError);
    }
  });

  it.each([
    ["request", { ...contentContext, requestId: "r_other" }],
    ["record type", { ...contentContext, recordType: "attachment" }],
    ["record ID", { ...contentContext, recordId: "e_other" }],
    ["field", { ...contentContext, field: "url" }],
    ["author", { ...contentContext, authorRole: "agent" as const }],
    [
      "missing author",
      {
        requestId: contentContext.requestId,
        recordType: contentContext.recordType,
        recordId: contentContext.recordId,
        field: contentContext.field,
      },
    ],
  ])("rejects content moved to a different %s context", (_label, wrongContext) => {
    const contentKey = generateContentKey();
    const envelope = sealText({ plaintext: "bound value", contentKey, context: contentContext });

    expect(() => openText({ envelope, contentKey, context: wrongContext })).toThrow(
      ContentCryptoError,
    );
  });

  it("rejects malformed, non-canonical, unknown, and wrong-length envelope components", () => {
    const contentKey = generateContentKey();
    const envelope = sealText({ plaintext: "private", contentKey, context: contentContext });
    const components = envelope.split(".");

    expect(() =>
      openText({
        envelope: `v2.${components.slice(1).join(".")}`,
        contentKey,
        context: contentContext,
      }),
    ).toThrow(/unsupported envelope/);
    expect(() =>
      openText({ envelope: `${envelope}.extra`, contentKey, context: contentContext }),
    ).toThrow(/unsupported envelope/);
    expect(() =>
      openText({
        envelope: replaceComponent(envelope, 1, randomBytes(GCM_NONCE_BYTES - 1)),
        contentKey,
        context: contentContext,
      }),
    ).toThrow(/nonce has an invalid length/);
    expect(() =>
      openText({
        envelope: replaceComponent(envelope, 3, randomBytes(GCM_TAG_BYTES - 1)),
        contentKey,
        context: contentContext,
      }),
    ).toThrow(/tag has an invalid length/);
    expect(() =>
      openText({
        envelope: `${components[0]}.${components[1]}=.${components[2]}.${components[3]}`,
        contentKey,
        context: contentContext,
      }),
    ).toThrow(/canonical base64url/);
    expect(() =>
      sealText({ plaintext: "private", contentKey: randomBytes(31), context: contentContext }),
    ).toThrow(/exactly 32 bytes/);
  });

  it("uses a fresh nonce for every encryption", () => {
    const contentKey = generateContentKey();
    const nonces = new Set<string>();

    for (let index = 0; index < 10_000; index += 1) {
      const envelope = sealText({
        plaintext: "same plaintext",
        contentKey,
        context: contentContext,
      });
      const nonce = envelope.split(".")[1] as string;
      expect(nonces.has(nonce)).toBe(false);
      nonces.add(nonce);
    }

    expect(nonces).toHaveLength(10_000);
  });

  it("leaves neither a text sentinel nor WebP header in ciphertext", () => {
    const contentKey = generateContentKey();
    const sentinel = "RAISE-PLAINTEXT-SENTINEL-3a1e259f";
    const textEnvelope = sealText({ plaintext: sentinel, contentKey, context: contentContext });
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([24, 0, 0, 0]),
      Buffer.from("WEBPVP8 ", "ascii"),
      randomBytes(24),
    ]);
    const imageEnvelope = sealContent({
      plaintext: webp,
      contentKey,
      context: { ...contentContext, recordType: "attachment", recordId: "att_one", field: "bytes" },
    });
    const textCiphertext = Buffer.from(textEnvelope.split(".")[2] as string, "base64url");
    const imageCiphertext = Buffer.from(imageEnvelope.split(".")[2] as string, "base64url");

    expect(textEnvelope).not.toContain(sentinel);
    expect(textCiphertext.includes(Buffer.from(sentinel))).toBe(false);
    expect(imageCiphertext.includes(Buffer.from("RIFF", "ascii"))).toBe(false);
    expect(imageCiphertext.includes(Buffer.from("WEBP", "ascii"))).toBe(false);
  });
});

describe("capability content-key wrapping", () => {
  it("round-trips a 256-bit content key using a versioned envelope", () => {
    const contentKey = generateContentKey();
    const capabilitySecret = randomBytes(32);
    const envelope = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext });
    const components = envelope.split(".");

    expect(components[0]).toBe("wk1");
    expect(Buffer.from(components[1] as string, "base64url")).toHaveLength(CAPABILITY_SALT_BYTES);
    expect(Buffer.from(components[2] as string, "base64url")).toHaveLength(GCM_NONCE_BYTES);
    expect(Buffer.from(components[3] as string, "base64url")).toHaveLength(CONTENT_KEY_BYTES);
    expect(Buffer.from(components[4] as string, "base64url")).toHaveLength(GCM_TAG_BYTES);
    expect(unwrapContentKey({ envelope, capabilitySecret, context: wrapContext })).toEqual(
      contentKey,
    );
  });

  it("uses an independent salt and nonce for each capability envelope", () => {
    const contentKey = generateContentKey();
    const capabilitySecret = randomBytes(32);
    const first = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext }).split(".");
    const second = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext }).split(
      ".",
    );

    expect(first[1]).not.toBe(second[1]);
    expect(first[2]).not.toBe(second[2]);
    expect(first.join(".")).not.toBe(second.join("."));
  });

  it("rejects the wrong capability secret and moved wrap contexts", () => {
    const contentKey = generateContentKey();
    const capabilitySecret = randomBytes(32);
    const envelope = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext });

    expect(() =>
      unwrapContentKey({ envelope, capabilitySecret: randomBytes(32), context: wrapContext }),
    ).toThrow(ContentCryptoError);

    const wrongContexts: ContentKeyWrapContext[] = [
      { ...wrapContext, requestId: "r_other" },
      { ...wrapContext, capabilityId: "c_other" },
      { ...wrapContext, role: "agent" },
      { ...wrapContext, purpose: "session" },
    ];
    for (const context of wrongContexts) {
      expect(() => unwrapContentKey({ envelope, capabilitySecret, context })).toThrow(
        ContentCryptoError,
      );
    }
  });

  it("rejects altered salt, nonce, wrapped key, and tag", () => {
    const contentKey = generateContentKey();
    const capabilitySecret = randomBytes(32);
    const envelope = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext });

    for (const component of [1, 2, 3, 4]) {
      expect(() =>
        unwrapContentKey({
          envelope: flipComponent(envelope, component),
          capabilitySecret,
          context: wrapContext,
        }),
      ).toThrow(ContentCryptoError);
    }
  });

  it("rejects malformed components and weak inputs", () => {
    const contentKey = generateContentKey();
    const capabilitySecret = randomBytes(32);
    const envelope = wrapContentKey({ contentKey, capabilitySecret, context: wrapContext });

    expect(() =>
      unwrapContentKey({
        envelope: replaceComponent(envelope, 1, randomBytes(CAPABILITY_SALT_BYTES - 1)),
        capabilitySecret,
        context: wrapContext,
      }),
    ).toThrow(/salt has an invalid length/);
    expect(() =>
      unwrapContentKey({
        envelope: replaceComponent(envelope, 2, randomBytes(GCM_NONCE_BYTES - 1)),
        capabilitySecret,
        context: wrapContext,
      }),
    ).toThrow(/nonce has an invalid length/);
    expect(() =>
      unwrapContentKey({
        envelope: replaceComponent(envelope, 3, randomBytes(CONTENT_KEY_BYTES - 1)),
        capabilitySecret,
        context: wrapContext,
      }),
    ).toThrow(/Wrapped key has an invalid length/);
    expect(() =>
      unwrapContentKey({
        envelope: replaceComponent(envelope, 4, randomBytes(GCM_TAG_BYTES - 1)),
        capabilitySecret,
        context: wrapContext,
      }),
    ).toThrow(/tag has an invalid length/);
    expect(() =>
      wrapContentKey({
        contentKey: randomBytes(CONTENT_KEY_BYTES - 1),
        capabilitySecret,
        context: wrapContext,
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      wrapContentKey({ contentKey, capabilitySecret: randomBytes(15), context: wrapContext }),
    ).toThrow(/at least 16 bytes/);
  });
});
