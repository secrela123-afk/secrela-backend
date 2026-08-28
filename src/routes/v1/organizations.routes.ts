import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as invitationController from "../../controllers/invitation.controller.js";
import * as organizationController from "../../controllers/organization.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireFullAuth } from "../../middleware/requireAuth.js";
import { requireEmailVerified } from "../../middleware/requireEmailVerified.js";
import { requireActiveSubscription } from "../../middleware/requireActiveSubscription.js";
import {
  requireMembership,
  requirePermission,
} from "../../middleware/requirePermission.js";
import { validateBody } from "../../middleware/validateBody.js";
import { createInvitationBodySchema } from "../../schemas/invitation.schemas.js";
import {
  activateSubscriptionBodySchema,
  createOrganizationBodySchema,
  createRoleBodySchema,
  extendTrialBodySchema,
  updateAutoRenewBodySchema,
  updateMemberRoleBodySchema,
  updateOrganizationBodySchema,
  updateRoleBodySchema,
} from "../../schemas/organization.schemas.js";
import * as roleController from "../../controllers/role.controller.js";
import { vaultsRouter } from "./vaults.routes.js";
import { secretsRouter } from "./secrets.routes.js";
import { accessRequestsRouter } from "./accessRequests.routes.js";
import { notificationsRouter } from "./notifications.routes.js";
import { auditLogsRouter } from "./auditLogs.routes.js";
import { securityCenterRouter } from "./securityCenter.routes.js";
import { overviewRouter } from "./overview.routes.js";

/**
 * Organizations — multi-tenant root for SecureVault.
 *
 * POST /     — create org (no membership yet) → requireFullAuth + email verified
 * Billing endpoints — membership only (allowed when expired / pending_payment)
 * Workspace APIs — membership + active subscription
 */
export const organizationsRouter = Router();

organizationsRouter.use(requireFullAuth);
organizationsRouter.use(requireEmailVerified);

const billingWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Too many billing updates. Try again later.",
      code: "RATE_LIMITED",
    },
  },
});

organizationsRouter.post(
  "/",
  validateBody(createOrganizationBodySchema),
  asyncHandler(organizationController.create),
);

/** —— Billing (no active-subscription gate) —— */
organizationsRouter.get(
  "/current/subscription",
  requireMembership,
  requirePermission("org.read"),
  asyncHandler(organizationController.subscriptionBilling),
);

organizationsRouter.get(
  "/current/entitlements",
  requireMembership,
  requirePermission("org.read"),
  asyncHandler(organizationController.entitlements),
);

organizationsRouter.post(
  "/current/subscription/activate",
  billingWriteLimiter,
  requireMembership,
  requirePermission("org.update"),
  validateBody(activateSubscriptionBodySchema),
  asyncHandler(organizationController.activateSubscription),
);

organizationsRouter.patch(
  "/current/subscription/auto-renew",
  billingWriteLimiter,
  requireMembership,
  requirePermission("org.update"),
  validateBody(updateAutoRenewBodySchema),
  asyncHandler(organizationController.updateAutoRenew),
);

organizationsRouter.post(
  "/current/subscription/extend-trial",
  requireMembership,
  requirePermission("org.update"),
  validateBody(extendTrialBodySchema),
  asyncHandler(organizationController.extendTrial),
);

organizationsRouter.get(
  "/current/subscription/trial-summary",
  requireMembership,
  requirePermission("org.read"),
  asyncHandler(organizationController.trialSummary),
);

/** —— Workspace (active subscription required) —— */
const active = [requireMembership, requireActiveSubscription] as const;

organizationsRouter.get(
  "/current",
  ...active,
  requirePermission("org.read"),
  asyncHandler(organizationController.current),
);

organizationsRouter.patch(
  "/current",
  ...active,
  requirePermission("org.update"),
  validateBody(updateOrganizationBodySchema),
  asyncHandler(organizationController.updateCurrent),
);

organizationsRouter.get(
  "/current/members",
  ...active,
  requirePermission("member.read"),
  asyncHandler(organizationController.listMembers),
);

organizationsRouter.patch(
  "/current/members/:membershipId",
  ...active,
  requirePermission("member.role.update"),
  validateBody(updateMemberRoleBodySchema),
  asyncHandler(organizationController.updateMemberRole),
);

organizationsRouter.delete(
  "/current/members/:membershipId",
  ...active,
  requirePermission("member.remove"),
  asyncHandler(organizationController.removeMember),
);

organizationsRouter.post(
  "/current/members/:membershipId/disable",
  ...active,
  requirePermission("member.disable"),
  asyncHandler(organizationController.disableMember),
);

organizationsRouter.post(
  "/current/members/:membershipId/enable",
  ...active,
  requirePermission("member.disable"),
  asyncHandler(organizationController.enableMember),
);

organizationsRouter.get(
  "/current/roles-matrix",
  ...active,
  requirePermission("role.read"),
  asyncHandler(organizationController.rolesMatrix),
);

organizationsRouter.get(
  "/current/roles",
  ...active,
  requirePermission("role.read"),
  asyncHandler(roleController.list),
);

organizationsRouter.post(
  "/current/roles",
  ...active,
  requirePermission("role.manage"),
  validateBody(createRoleBodySchema),
  asyncHandler(roleController.create),
);

organizationsRouter.patch(
  "/current/roles/:roleId",
  ...active,
  requirePermission("role.manage"),
  validateBody(updateRoleBodySchema),
  asyncHandler(roleController.update),
);

organizationsRouter.delete(
  "/current/roles/:roleId",
  ...active,
  requirePermission("role.manage"),
  asyncHandler(roleController.remove),
);

organizationsRouter.post(
  "/current/invites",
  ...active,
  requirePermission("member.invite"),
  validateBody(createInvitationBodySchema),
  asyncHandler(invitationController.create),
);

organizationsRouter.get(
  "/current/invites",
  ...active,
  requirePermission("member.read"),
  asyncHandler(invitationController.listPending),
);

organizationsRouter.post(
  "/current/invites/:invitationId/resend",
  ...active,
  requirePermission("member.invite"),
  asyncHandler(invitationController.resend),
);

organizationsRouter.delete(
  "/current/invites/:invitationId",
  ...active,
  requirePermission("member.invite"),
  asyncHandler(invitationController.revoke),
);

organizationsRouter.use("/current/vaults", vaultsRouter);
organizationsRouter.use("/current/secrets", secretsRouter);
organizationsRouter.use("/current/access-requests", accessRequestsRouter);
organizationsRouter.use("/current/notifications", notificationsRouter);
organizationsRouter.use("/current/audit-logs", auditLogsRouter);
organizationsRouter.use("/current/security-center", securityCenterRouter);
organizationsRouter.use("/current/overview", overviewRouter);
