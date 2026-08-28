import { Router } from "express";
import * as notificationController from "../../controllers/notification.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireMembership } from "../../middleware/requirePermission.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";

export const notificationsRouter = Router({ mergeParams: true });

notificationsRouter.use(requireMembership, requireActiveSubscription);

notificationsRouter.get("/", asyncHandler(notificationController.list));

notificationsRouter.post(
  "/read-all",
  asyncHandler(notificationController.markAllRead),
);

notificationsRouter.delete(
  "/",
  asyncHandler(notificationController.removeAll),
);

notificationsRouter.post(
  "/:notificationId/read",
  asyncHandler(notificationController.markRead),
);

notificationsRouter.delete(
  "/:notificationId",
  asyncHandler(notificationController.remove),
);
