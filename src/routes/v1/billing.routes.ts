import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as billingController from "../../controllers/billing.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireFullAuth } from "../../middleware/requireAuth.js";
import { requireEmailVerified } from "../../middleware/requireEmailVerified.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { validateBody } from "../../middleware/validateBody.js";
import { createCheckoutBodySchema } from "../../schemas/billing.schemas.js";

/**
 * Billing — Lemon Squeezy Merchant of Record.
 *
 * POST /webhooks/lemonsqueezy — no session (HMAC verified)
 * GET  /overview — owner/admin billing dashboard data
 * POST /checkout — create hosted checkout URL
 */
export const billingRouter = Router();

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Too many checkout attempts. Try again later.",
      code: "RATE_LIMITED",
    },
  },
});

billingRouter.post(
  "/webhooks/lemonsqueezy",
  asyncHandler(billingController.lemonWebhook),
);

billingRouter.use(requireFullAuth);
billingRouter.use(requireEmailVerified);
billingRouter.use(requireMembership);

billingRouter.get(
  "/overview",
  requirePermission("org.read"),
  asyncHandler(billingController.billingOverview),
);

billingRouter.post(
  "/checkout",
  checkoutLimiter,
  requirePermission("org.update"),
  validateBody(createCheckoutBodySchema),
  asyncHandler(billingController.createCheckout),
);
