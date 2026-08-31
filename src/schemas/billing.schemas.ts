import { z } from "zod";
import { BILLING_INTERVALS } from "../lib/subscriptionPlans.js";

export const createCheckoutBodySchema = z.object({
  planSlug: z.enum(["starter", "team"]),
  interval: z.enum(BILLING_INTERVALS),
});

export const captureCardBodySchema = z.object({
  orderId: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[A-Z0-9-]+$/i),
});

export const confirmPaddleBodySchema = z.object({
  transactionId: z
    .string()
    .trim()
    .min(8)
    .max(80)
    .regex(/^txn_[a-z0-9]+$/i),
});

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>;
