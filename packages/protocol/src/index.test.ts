import { describe, expect, it } from "vitest";
import {
  attachmentPreviewSchema,
  changesQuerySchema,
  claimSchema,
  claimResponseSchema,
  createRaiseSchema,
  createRaiseResponseSchema,
  dataUrlByteLength,
  idempotencyKeySchema,
  lifecycleSchema,
  maxAttachmentBytesPerEntry,
  maxAttachmentsPerEntry,
  postEntrySchema,
  raiseViewSchema,
} from "./index.js";

const tinyAttachment = {
  name: "screen.png",
  mimeType: "image/png" as const,
  dataUrl: "data:image/png;base64,YQ==",
};

describe("request lifecycle", () => {
  it("exposes only states the workflow can produce", () => {
    expect(lifecycleSchema.options).toEqual(["open", "resolved"]);
  });
});

describe("attachment input limits", () => {
  it("counts decoded data URL bytes", () => {
    expect(dataUrlByteLength("data:image/png;base64,YQ==")).toBe(1);
    expect(dataUrlByteLength("data:image/png;base64,YWI=")).toBe(2);
    expect(dataUrlByteLength("data:image/png;base64,YWJj")).toBe(3);
  });

  it("accepts more than four small screenshots", () => {
    expect(
      createRaiseSchema.safeParse({
        origin: "human",
        attachments: Array.from({ length: 5 }, (_, index) => ({
          ...tinyAttachment,
          name: `screen-${index}.png`,
        })),
      }).success,
    ).toBe(true);
  });

  it("rejects screenshots over the combined byte budget", () => {
    const encoded = "A".repeat(Math.ceil(((maxAttachmentBytesPerEntry + 1) * 4) / 3));
    const attachment = {
      ...tinyAttachment,
      dataUrl: `data:image/png;base64,${encoded}`,
    };

    expect(
      createRaiseSchema.safeParse({ origin: "human", attachments: [attachment] }).success,
    ).toBe(false);
    expect(
      postEntrySchema.safeParse({
        kind: "result",
        attachments: [attachment],
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("keeps an internal ceiling for implausibly large arrays", () => {
    expect(
      createRaiseSchema.safeParse({
        origin: "human",
        attachments: Array.from({ length: maxAttachmentsPerEntry + 1 }, () => tinyAttachment),
      }).success,
    ).toBe(false);
  });
});

describe("request URLs", () => {
  it("accepts only HTTP and HTTPS references", () => {
    for (const url of ["http://localhost:3000/path", "https://example.com/path?q=one"]) {
      expect(createRaiseSchema.safeParse({ origin: "human", url }).success).toBe(true);
      expect(postEntrySchema.safeParse({ kind: "comment", url, expectedVersion: 1 }).success).toBe(
        true,
      );
    }

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "ftp://example.com/file",
      "not a URL",
      "http://",
    ]) {
      expect(createRaiseSchema.safeParse({ origin: "human", url }).success).toBe(false);
      expect(postEntrySchema.safeParse({ kind: "comment", url, expectedVersion: 1 }).success).toBe(
        false,
      );
    }
  });
});

describe("HTTP query values", () => {
  it("accepts only the documented preview and bounded change query", () => {
    expect(attachmentPreviewSchema.safeParse(undefined).success).toBe(true);
    expect(attachmentPreviewSchema.safeParse("mcp").success).toBe(true);
    expect(attachmentPreviewSchema.safeParse("thumbnail").success).toBe(false);

    expect(changesQuerySchema.parse({ cursor: "0-0" })).toEqual({ cursor: "0-0", wait: 0 });
    expect(changesQuerySchema.parse({ cursor: "1725552123456-2", wait: "30" })).toEqual({
      cursor: "1725552123456-2",
      wait: 30,
    });
    for (const cursor of [
      "",
      "12",
      "-1-0",
      "1.5-0",
      "1-",
      "1-2-3",
      "18446744073709551616-0",
      "0-18446744073709551616",
    ]) {
      expect(changesQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
    for (const wait of ["-1", "1.5", "31", "abc"]) {
      expect(changesQuerySchema.safeParse({ cursor: "0-0", wait }).success).toBe(false);
    }
  });
});

describe("claim exchange", () => {
  it("requires the request ID that owns the capability", () => {
    const input = {
      raiseId: "r_example12",
      token: "cap_example.private-claim-secret",
      mode: "token",
    };

    expect(claimSchema.safeParse(input).success).toBe(true);
    expect(claimSchema.safeParse({ ...input, raiseId: undefined }).success).toBe(false);
    expect(claimSchema.safeParse({ ...input, raiseId: "other" }).success).toBe(false);
  });
});

describe("mutation idempotency keys", () => {
  it("accepts UUID and base64url values with enough entropy", () => {
    expect(idempotencyKeySchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse("c29tZS1oaWdoLWVudHJvcHkta2V5").success).toBe(true);
  });

  it("rejects short, spaced, and oversized values", () => {
    for (const value of ["too-short", "not allowed because spaces", "a".repeat(129)]) {
      expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("API responses", () => {
  it("validates successful responses before clients consume them", () => {
    expect(
      createRaiseResponseSchema.safeParse({
        raiseId: "r_example12",
        ownerClaimUrl: "https://raise.example/r/r_example12#token=owner",
        targetClaimUrl: "https://raise.example/r/r_example12#token=target",
        targetRole: "agent",
      }).success,
    ).toBe(true);
    expect(
      claimResponseSchema.safeParse({
        raiseId: "r_example12",
        role: "human",
        expiresAt: "2026-09-01T02:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(raiseViewSchema.safeParse({ id: "r_example12", version: 1 }).success).toBe(false);
  });
});
