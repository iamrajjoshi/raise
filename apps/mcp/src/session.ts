import { claimResponseSchema } from "@raise/protocol";
import * as z from "zod/v4";

export const storedSessionSchema = claimResponseSchema
  .pick({ raiseId: true, role: true, expiresAt: true })
  .extend({
    server: z.url(),
    token: z.string().min(1),
  });

export type StoredSession = z.infer<typeof storedSessionSchema>;
