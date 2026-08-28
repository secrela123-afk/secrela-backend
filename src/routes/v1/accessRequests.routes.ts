import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import * as accessRequestController from "../../controllers/accessRequest.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { AppError } from "../../lib/errors/AppError.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";
import { validateBody } from "../../middleware/validateBody.js";
import {
  createAccessRequestBodySchema,
  reviewAccessRequestBodySchema,
} from "../../schemas/accessRequest.schemas.js";

/**
 * Access requests under /api/v1/organizations/current/access-requests
 * Review UI is Owner/Admin only. Create is for non-Owner/Admin members.
 */
export const accessRequestsRouter = Router({ mergeParams: true });

accessRequestsRouter.use(requireMembership, requireActiveSubscription);

function requireOwnerOrAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const key = req.authMembership?.systemKey;
  if (key === "owner" || key === "admin") {
    next();
    return;
  }
  next(
    new AppError(403, "Only Owner or Admin can review access requests", {
      code: "FORBIDDEN",
      details: { required: "owner|admin" },
    }),
  );
}

/** Members (non Owner/Admin) create requests; Owner/Admin already have reveal. */
function requireNotOwnerOrAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const key = req.authMembership?.systemKey;
  if (key === "owner" || key === "admin") {
    next(
      new AppError(
        403,
        "Owners and Admins already have secret access — they cannot create access requests",
        { code: "OWNER_ADMIN_CANNOT_REQUEST" },
      ),
    );
    return;
  }
  next();
}

accessRequestsRouter.get(
  "/",
  requireOwnerOrAdmin,
  asyncHandler(accessRequestController.list),
);

accessRequestsRouter.post(
  "/",
  requireNotOwnerOrAdmin,
  requirePermission("secret.read"),
  validateBody(createAccessRequestBodySchema),
  asyncHandler(accessRequestController.create),
);

accessRequestsRouter.post(
  "/:requestId/approve",
  requireOwnerOrAdmin,
  requirePermission("access_request.review"),
  validateBody(reviewAccessRequestBodySchema),
  asyncHandler(accessRequestController.approve),
);

accessRequestsRouter.post(
  "/:requestId/deny",
  requireOwnerOrAdmin,
  requirePermission("access_request.review"),
  validateBody(reviewAccessRequestBodySchema),
  asyncHandler(accessRequestController.deny),
);

accessRequestsRouter.post(
  "/:requestId/revoke",
  requireOwnerOrAdmin,
  requirePermission("access_request.review"),
  asyncHandler(accessRequestController.revoke),
);
