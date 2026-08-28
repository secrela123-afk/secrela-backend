import { z } from "zod";
import {
  ACCESS_DURATION_MINUTES,
  ACCESS_PERMISSIONS,
} from "../models/AccessRequest.model.js";

export const createAccessRequestBodySchema = z.object({
  secretId: z.string().min(1, "Secret is required"),
  permission: z.enum(ACCESS_PERMISSIONS).optional().default("use"),
  durationMinutes: z.coerce
    .number()
    .refine(
      (n) => (ACCESS_DURATION_MINUTES as readonly number[]).includes(n),
      "Invalid duration",
    ),
  reason: z
    .string()
    .trim()
    .min(8, "Reason must be at least 8 characters")
    .max(500),
});

export const reviewAccessRequestBodySchema = z.object({
  note: z.string().trim().max(500).optional().default(""),
});

export type CreateAccessRequestBody = z.infer<
  typeof createAccessRequestBodySchema
>;
export type ReviewAccessRequestBody = z.infer<
  typeof reviewAccessRequestBodySchema
>;
