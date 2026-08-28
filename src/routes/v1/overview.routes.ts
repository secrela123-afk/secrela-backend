import { Router } from "express";
import * as overviewController from "../../controllers/overview.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireMembership } from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";

/** GET /api/v1/organizations/current/overview */
export const overviewRouter = Router({ mergeParams: true });

overviewRouter.use(requireMembership, requireActiveSubscription);

overviewRouter.get("/", asyncHandler(overviewController.getOverview));
