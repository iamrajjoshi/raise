import { describe, expect, it } from "vitest";
import {
  createRaiseSchema,
  dataUrlByteLength,
  inboxQuerySchema,
  inboxResponseSchema,
  maxAttachmentBytesPerEntry,
  maxAttachmentsPerEntry,
  postEntrySchema,
} from "./index.js";

const tinyAttachment = {
  name: "screen.png",
  mimeType: "image/png" as const,
  dataUrl: "data:image/png;base64,YQ==",
};

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

describe("inbox protocol", () => {
  it("defaults and validates the inbox page size", () => {
    expect(inboxQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(inboxQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(inboxQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ limit: "many" }).success).toBe(false);
  });

  it("validates compact inbox responses", () => {
    const timestamp = "2026-09-02T12:00:00.000Z";
    expect(
      inboxResponseSchema.parse({
        items: [
          {
            raiseId: "r_example",
            title: "Fix the clipped panel",
            origin: "human",
            waitingOn: "agent",
            pendingAction: "perform_work",
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: timestamp,
          },
        ],
      }),
    ).toMatchObject({ items: [{ raiseId: "r_example", waitingOn: "agent" }] });
  });
});
