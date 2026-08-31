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
import { createCheckoutBodySchema, captureCardBodySchema, confirmPaddleBodySchema } from "../../schemas/billing.schemas.js";

/**
 * Billing — PayPal Subscriptions.
 *
 * POST /webhooks/paypal — no session (PayPal signature verified)
 * GET  /overview — owner/admin billing dashboard data
 * POST /checkout — create PayPal approval URL
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
  "/webhooks/paypal",
  asyncHandler(billingController.paypalWebhook),
);

billingRouter.post(
  "/webhooks/paddle",
  asyncHandler(billingController.paddleWebhook),
);

billingRouter.get(
  "/paddle/config",
  asyncHandler(billingController.paddleCardConfig),
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

billingRouter.get(
  "/card/config",
  requirePermission("org.read"),
  asyncHandler(billingController.paypalCardConfig),
);

billingRouter.post(
  "/card/client-token",
  checkoutLimiter,
  requirePermission("org.update"),
  asyncHandler(billingController.paypalCardClientToken),
);

billingRouter.post(
  "/card/orders",
  checkoutLimiter,
  requirePermission("org.update"),
  validateBody(createCheckoutBodySchema),
  asyncHandler(billingController.createCardOrder),
);

billingRouter.post(
  "/card/capture",
  checkoutLimiter,
  requirePermission("org.update"),
  validateBody(captureCardBodySchema),
  asyncHandler(billingController.captureCardOrder),
);

billingRouter.post(
  "/paddle/checkout",
  checkoutLimiter,
  requirePermission("org.update"),
  validateBody(createCheckoutBodySchema),
  asyncHandler(billingController.createPaddleCheckout),
);

billingRouter.post(
  "/paddle/confirm",
  checkoutLimiter,
  requirePermission("org.update"),
  validateBody(confirmPaddleBodySchema),
  asyncHandler(billingController.confirmPaddleCheckout),
);
