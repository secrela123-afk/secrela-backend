import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as invitationController from "../../controllers/invitation.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireFullAuth } from "../../middleware/requireAuth.js";
import { validateBody } from "../../middleware/validateBody.js";
import { acceptInvitationBodySchema } from "../../schemas/invitation.schemas.js";

/**
 * Public invite preview + authenticated accept.
 * Org-scoped create/list/revoke stay under /organizations/current/invites.
 */
export const invitesRouter = Router();

const invitePreviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many invite lookups. Try again later.",
    },
  },
});

const inviteAcceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many invite accept attempts. Try again later.",
    },
  },
});

invitesRouter.get(
  "/by-token/:token",
  invitePreviewLimiter,
  asyncHandler(invitationController.preview),
);

invitesRouter.get(
  "/pending-for-me",
  requireFullAuth,
  asyncHandler(invitationController.pendingForMe),
);

invitesRouter.post(
  "/accept-pending",
  inviteAcceptLimiter,
  requireFullAuth,
  asyncHandler(invitationController.acceptPending),
);

invitesRouter.post(
  "/accept",
  inviteAcceptLimiter,
  requireFullAuth,
  validateBody(acceptInvitationBodySchema),
  asyncHandler(invitationController.accept),
);
