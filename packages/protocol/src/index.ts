import { z } from "zod";

export const roleSchema = z.enum(["human", "agent"]);
export type Role = z.infer<typeof roleSchema>;

export const lifecycleSchema = z.enum(["open", "resolved", "cancelled", "expired"]);
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

export const maxAttachmentsPerEntry = 32;
export const maxAttachmentBytesPerEntry = 15 * 1_024 * 1_024;
export const attachmentBudgetMessage =
  "Those screenshots are over the 15 MB limit together. Try smaller copies or remove one.";

export function dataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return 0;

  const encoded = dataUrl.slice(commaIndex + 1).replace(/\s/g, "");
  if (!encoded) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

export const attachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(180),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
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

export const createRaiseSchema = z
  .object({
    origin: roleSchema,
    title: z.string().trim().min(1).max(180).optional(),
    prompt: z.string().trim().max(20_000).default(""),
    url: z.url().max(2_048).optional(),
    attachments: attachmentsInputSchema.default([]),
    expiresInHours: z.number().int().min(1).max(168).default(24),
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

export const claimSchema = z.object({
  token: z.string().min(20).max(400),
  mode: z.enum(["cookie", "token"]).default("cookie"),
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
    body: z.string().trim().max(20_000).default(""),
    url: z.url().max(2_048).optional(),
    decision: decisionSchema.optional(),
    attachments: attachmentsInputSchema.default([]),
    expectedVersion: z.number().int().min(1),
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

export interface AttachmentView {
  id: string;
  name: string;
  mediaType: "image/webp";
  url: string;
  width: number;
  height: number;
}

export interface EntryView {
  id: string;
  authorRole: Role;
  kind: EntryKind;
  body: string;
  url?: string;
  decision?: Decision;
  createdAt: string;
  attachments: AttachmentView[];
}

export type PendingActionKind =
  "provide_context" | "perform_work" | "review_result" | "make_changes";

export interface RaiseView {
  id: string;
  title: string;
  origin: Role;
  viewerRole: Role;
  lifecycle: Lifecycle;
  waitingOn: Role | null;
  pendingAction: PendingActionKind | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  permissions: {
    canReply: boolean;
    canPostResult: boolean;
    canReview: boolean;
    canComment: boolean;
  };
  entries: EntryView[];
}

export interface CreateRaiseResponse {
  raiseId: string;
  ownerClaimUrl: string;
  targetClaimUrl: string;
  targetRole: Role;
}

export interface ClaimResponse {
  raiseId: string;
  role: Role;
  token?: string;
  expiresAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
