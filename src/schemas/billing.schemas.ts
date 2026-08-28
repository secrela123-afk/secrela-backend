import { z } from "zod";
import { BILLING_INTERVALS } from "../lib/subscriptionPlans.js";

export const createCheckoutBodySchema = z.object({
  planSlug: z.enum(["starter", "team"]),
  interval: z.enum(BILLING_INTERVALS),
});

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>;
