import { Router } from "express";
import * as securityCenterController from "../../controllers/securityCenter.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";

/**
 * Security Center under /api/v1/organizations/current/security-center
 */
export const securityCenterRouter = Router({ mergeParams: true });

securityCenterRouter.use(requireMembership, requireActiveSubscription);

securityCenterRouter.get(
  "/",
  requirePermission("audit.read"),
  asyncHandler(securityCenterController.getSecurityCenter),
);
