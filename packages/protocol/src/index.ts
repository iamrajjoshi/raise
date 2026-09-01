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

export const attachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(180),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataUrl: z.string().max(22_000_000),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

export const createRaiseSchema = z.object({
  origin: roleSchema,
  title: z.string().trim().min(1).max(180).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  url: z.url().max(2_048).optional(),
  attachments: z.array(attachmentInputSchema).max(4).default([]),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
export type CreateRaiseInput = z.infer<typeof createRaiseSchema>;

export const claimSchema = z.object({
  token: z.string().min(20).max(400),
  mode: z.enum(["cookie", "token"]).default("cookie"),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const postEntrySchema = z
  .object({
    kind: z.enum(["response", "result", "comment", "review_decision"]),
    body: z.string().trim().max(20_000).default(""),
    url: z.url().max(2_048).optional(),
    decision: decisionSchema.optional(),
    attachments: z.array(attachmentInputSchema).max(4).default([]),
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((value, context) => {
    if (value.kind === "review_decision" && !value.decision) {
      context.addIssue({ code: "custom", path: ["decision"], message: "A decision is required." });
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
        message: "Add text, a URL, or an image.",
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
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
