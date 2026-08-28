import { Router } from "express";
import * as auditController from "../../controllers/audit.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";

/**
 * Audit logs under /api/v1/organizations/current/audit-logs
 * Read-only append-only history — requires audit.read.
 */
export const auditLogsRouter = Router({ mergeParams: true });

auditLogsRouter.use(requireMembership, requireActiveSubscription);

auditLogsRouter.get(
  "/",
  requirePermission("audit.read"),
  asyncHandler(auditController.list),
);
