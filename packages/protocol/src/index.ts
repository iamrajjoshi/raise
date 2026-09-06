import { z } from "zod";

export const roleSchema = z.enum(["human", "agent"]);
export type Role = z.infer<typeof roleSchema>;

export const lifecycleSchema = z.enum(["open", "resolved"]);
export type Lifecycle = z.infer<typeof lifecycleSchema>;

export const entryKindSchema = z.enum([
  "prompt",
  "response",
  "result",
  "comment",
  "review_decision",
]);
export type EntryKind = z.infer<typeof entryKindSchema>;

export const decisionSchema = z.enum(["accept", "request_changes"]);
export type Decision = z.infer<typeof decisionSchema>;

export const pendingActionKindSchema = z.enum([
  "provide_context",
  "perform_work",
  "review_result",
  "make_changes",
]);
export type PendingActionKind = z.infer<typeof pendingActionKindSchema>;

export const maxAttachmentsPerEntry = 32;
export const maxAttachmentBytesPerEntry = 15 * 1_024 * 1_024;
export const maxContentCharacters = 20_000;
export const attachmentBudgetMessage =
  "Those screenshots are over the 15 MB limit together. Try smaller copies or remove one.";
export const supportedAttachmentMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export const attachmentMimeTypeSchema = z.enum(supportedAttachmentMimeTypes);

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "[::1]") return true;

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

export function dataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return 0;

  const encoded = dataUrl.slice(commaIndex + 1).replace(/\s/g, "");
  if (!encoded) return 0;
  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

export const attachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(180),
  mimeType: attachmentMimeTypeSchema,
  dataUrl: z.string().max(22_000_000),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

export const attachmentsInputSchema = z
  .array(attachmentInputSchema)
  .max(maxAttachmentsPerEntry)
  .superRefine((attachments, context) => {
    const totalBytes = attachments.reduce(
      (total, attachment) => total + dataUrlByteLength(attachment.dataUrl),
      0,
    );
    if (totalBytes > maxAttachmentBytesPerEntry) {
      context.addIssue({
        code: "custom",
        message: attachmentBudgetMessage,
      });
    }
  });

export const httpUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => /^https?:\/\//iu.test(value), "Use an HTTP or HTTPS URL.");

export const titleInputSchema = z.string().trim().min(1).max(180);
export const contentTextSchema = z.string().trim().max(maxContentCharacters);
export const expectedVersionSchema = z.number().int().min(1);

export const createRaiseSchema = z
  .object({
    origin: roleSchema,
    title: titleInputSchema.optional(),
    prompt: contentTextSchema.default(""),
    url: httpUrlSchema.optional(),
    attachments: attachmentsInputSchema.default([]),
  })
  .superRefine((value, context) => {
    if (!value.prompt && !value.url && !value.attachments.length) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "Add some text, a link, or a screenshot.",
      });
    }
  });
export type CreateRaiseInput = z.infer<typeof createRaiseSchema>;

export const claimModeSchema = z.enum(["cookie", "token"]);
export type ClaimMode = z.infer<typeof claimModeSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "Use a 16–128 character UUID or base64url value.");

export const raiseIdSchema = z.string().regex(/^r_[A-Za-z0-9_-]{1,97}$/);
export const attachmentPreviewSchema = z.literal("mcp").optional();
const maxUnsigned64 = 18_446_744_073_709_551_615n;
function cursorPartsFitUnsigned64(value: string): boolean {
  try {
    const parts = value.split("-");
    return parts.length === 2 && parts.every((part) => BigInt(part) <= maxUnsigned64);
  } catch {
    return false;
  }
}

export const raiseCursorSchema = z
  .string()
  .max(41)
  .regex(/^(?:0|[1-9]\d{0,19})-(?:0|[1-9]\d{0,19})$/, "Use a cursor returned by Raise.")
  .refine(cursorPartsFitUnsigned64, "Use a cursor returned by Raise.");
export const raiseEntriesModeSchema = z.enum(["snapshot", "delta"]);
export type RaiseEntriesMode = z.infer<typeof raiseEntriesModeSchema>;
export const changesQuerySchema = z.object({
  cursor: raiseCursorSchema,
  wait: z
    .string()
    .regex(/^(?:[0-9]|[12]\d|30)$/)
    .optional()
    .default("0")
    .transform(Number),
});
export type ChangesQuery = z.infer<typeof changesQuerySchema>;

export const claimSchema = z.object({
  raiseId: raiseIdSchema,
  token: z.string().min(20).max(400),
  mode: claimModeSchema.default("cookie"),
  expectedRole: roleSchema.optional(),
  exchangeId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,100}$/)
    .optional(),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const postEntrySchema = z
  .object({
    kind: z.enum(["response", "result", "comment", "review_decision"]),
    body: contentTextSchema.default(""),
    url: httpUrlSchema.optional(),
    decision: decisionSchema.optional(),
    attachments: attachmentsInputSchema.default([]),
    expectedVersion: expectedVersionSchema,
  })
  .superRefine((value, context) => {
    if (value.kind === "review_decision" && !value.decision) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Choose accept or ask for changes.",
      });
    }
    if (value.decision === "request_changes" && !value.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Describe what needs to change.",
      });
    }
    if (
      value.kind !== "review_decision" &&
      !value.body &&
      !value.url &&
      !value.attachments.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Add some text, a link, or a screenshot.",
      });
    }
  });
export type PostEntryInput = z.infer<typeof postEntrySchema>;

const identifierSchema = z.string().min(1).max(180);
const timestampSchema = z.iso.datetime();

export const attachmentViewSchema = z.object({
  id: identifierSchema,
  name: z.string().max(180),
  mediaType: z.literal("image/webp"),
  url: z.string().min(1).max(2_048),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AttachmentView = z.infer<typeof attachmentViewSchema>;

export const entryViewSchema = z.object({
  id: identifierSchema,
  authorRole: roleSchema,
  kind: entryKindSchema,
  body: z.string(),
  url: httpUrlSchema.optional(),
  decision: decisionSchema.optional(),
  createdAt: timestampSchema,
  attachments: z.array(attachmentViewSchema),
});
export type EntryView = z.infer<typeof entryViewSchema>;

export const raisePermissionsSchema = z.object({
  canReply: z.boolean(),
  canPostResult: z.boolean(),
  canReview: z.boolean(),
  canComment: z.boolean(),
});
export type RaisePermissions = z.infer<typeof raisePermissionsSchema>;

export const raiseViewSchema = z.object({
  id: raiseIdSchema,
  title: z.string(),
  origin: roleSchema,
  viewerRole: roleSchema,
  lifecycle: lifecycleSchema,
  waitingOn: roleSchema.nullable(),
  pendingAction: pendingActionKindSchema.nullable(),
  version: z.number().int().positive(),
  cursor: raiseCursorSchema,
  entriesMode: raiseEntriesModeSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema,
  permissions: raisePermissionsSchema,
  entries: z.array(entryViewSchema),
});
export type RaiseView = z.infer<typeof raiseViewSchema>;

export const createRaiseResponseSchema = z.object({
  raiseId: raiseIdSchema,
  ownerClaimUrl: httpUrlSchema,
  targetClaimUrl: httpUrlSchema,
  targetRole: roleSchema,
});
export type CreateRaiseResponse = z.infer<typeof createRaiseResponseSchema>;

export const claimResponseSchema = z.object({
  raiseId: raiseIdSchema,
  role: roleSchema,
  token: z.string().min(1).optional(),
  expiresAt: timestampSchema,
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  // Error extensions are intentionally opaque to clients.
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
