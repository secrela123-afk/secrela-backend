import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as secretController from "../../controllers/secret.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireSecretRevealAuth } from "../../middleware/requireSecretRevealAuth.js";
import { requireSecretRevealAccess } from "../../middleware/requireSecretRevealAccess.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";
import { validateBody } from "../../middleware/validateBody.js";
import {
  createSecretBodySchema,
  updateSecretBodySchema,
} from "../../schemas/secret.schemas.js";

/**
 * Secrets under /api/v1/organizations/current/secrets
 * List returns metadata only — plaintext only via POST .../reveal (HIGH step-up).
 */
export const secretsRouter = Router({ mergeParams: true });

secretsRouter.use(requireMembership, requireActiveSubscription);

const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many reveal attempts. Try again later.",
    },
  },
});

const sensitiveWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many write attempts. Try again later.",
    },
  },
});

secretsRouter.get(
  "/",
  requirePermission("secret.read"),
  asyncHandler(secretController.list),
);

secretsRouter.post(
  "/",
  sensitiveWriteLimiter,
  requirePermission("secret.create"),
  validateBody(createSecretBodySchema),
  asyncHandler(secretController.create),
);

secretsRouter.patch(
  "/:secretId",
  sensitiveWriteLimiter,
  requirePermission("secret.update"),
  validateBody(updateSecretBodySchema),
  asyncHandler(secretController.update),
);

secretsRouter.delete(
  "/:secretId",
  sensitiveWriteLimiter,
  requirePermission("secret.delete"),
  asyncHandler(secretController.remove),
);

secretsRouter.post(
  "/:secretId/reveal",
  revealLimiter,
  requireSecretRevealAuth,
  requireSecretRevealAccess,
  asyncHandler(secretController.reveal),
);
