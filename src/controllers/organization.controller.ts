import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  ActivateSubscriptionBody,
  CreateOrganizationBody,
  ExtendTrialBody,
  UpdateAutoRenewBody,
  UpdateMemberRoleBody,
  UpdateOrganizationBody,
} from "../schemas/organization.schemas.js";
import {
  auditContextFromRequest,
  recordAudit,
} from "../services/audit.service.js";
import {
  activateSubscriptionForUser,
  createOrganizationForUser,
  disableMemberInOrganization,
  enableMemberInOrganization,
  extendTrialForCurrentOrganization,
  getCurrentOrganizationForUser,
  getRolesMatrixForUser,
  getSubscriptionBillingForUser,
  getTrialSummaryForUser,
  listCurrentOrganizationMembers,
  removeMemberFromOrganization,
  updateAutoRenewForUser,
  updateCurrentOrganizationForUser,
  updateMemberRoleForOrganization,
} from "../services/organization.service.js";
import { getPlanEntitlementSnapshot } from "../services/planEntitlement.service.js";

function requireUserId(req: Request): string {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }
  return req.authUser.id;
}

function requireOrganizationId(req: Request): string {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.organizationId;
}

export async function create(req: Request, res: Response) {
  const body = req.body as CreateOrganizationBody;
  const result = await createOrganizationForUser(requireUserId(req), body);
  res.status(201).json(result);
}

export async function current(req: Request, res: Response) {
  const result = await getCurrentOrganizationForUser(requireUserId(req));
  res.status(200).json(result);
}

export async function updateCurrent(req: Request, res: Response) {
  const body = req.body as UpdateOrganizationBody;
  const result = await updateCurrentOrganizationForUser(
    requireUserId(req),
    body,
  );
  res.status(200).json(result);
}

export async function listMembers(req: Request, res: Response) {
  const result = await listCurrentOrganizationMembers(requireUserId(req));
  res.status(200).json(result);
}

export async function updateMemberRole(req: Request, res: Response) {
  const body = req.body as UpdateMemberRoleBody;
  const organizationId = requireOrganizationId(req);
  const member = await updateMemberRoleForOrganization(
    requireUserId(req),
    organizationId,
    req.params.membershipId as string,
    body.roleId,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "member.role.updated",
    ...ctx,
    targetType: "member",
    targetId: member.id,
    targetLabel: member.user.email,
    metadata: { roleId: member.role.id, roleName: member.role.name },
  });
  res.status(200).json({ member });
}

export async function removeMember(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const membershipId = req.params.membershipId as string;
  const result = await removeMemberFromOrganization(
    requireUserId(req),
    organizationId,
    membershipId,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "member.removed",
    ...ctx,
    targetType: "member",
    targetId: membershipId,
    targetLabel: membershipId,
  });
  res.status(200).json(result);
}

export async function disableMember(req: Request, res: Response) {
  const member = await disableMemberInOrganization(
    requireUserId(req),
    requireOrganizationId(req),
    req.params.membershipId as string,
  );
  res.status(200).json({ member });
}

export async function enableMember(req: Request, res: Response) {
  const member = await enableMemberInOrganization(
    requireUserId(req),
    requireOrganizationId(req),
    req.params.membershipId as string,
  );
  res.status(200).json({ member });
}

export async function rolesMatrix(req: Request, res: Response) {
  const result = await getRolesMatrixForUser(requireUserId(req));
  res.status(200).json(result);
}

export async function extendTrial(req: Request, res: Response) {
  const body = req.body as ExtendTrialBody;
  const result = await extendTrialForCurrentOrganization(
    requireUserId(req),
    body.days,
  );
  res.status(200).json(result);
}

export async function trialSummary(req: Request, res: Response) {
  const result = await getTrialSummaryForUser(requireUserId(req));
  res.status(200).json(result);
}

export async function subscriptionBilling(req: Request, res: Response) {
  const result = await getSubscriptionBillingForUser(requireUserId(req));
  res.status(200).json(result);
}

export async function activateSubscription(req: Request, res: Response) {
  const body = req.body as ActivateSubscriptionBody;
  const result = await activateSubscriptionForUser(
    requireUserId(req),
    body.planSlug,
    body.interval,
  );
  res.status(200).json(result);
}

export async function updateAutoRenew(req: Request, res: Response) {
  const body = req.body as UpdateAutoRenewBody;
  const result = await updateAutoRenewForUser(requireUserId(req), body);
  res.status(200).json(result);
}

export async function entitlements(req: Request, res: Response) {
  const snapshot = await getPlanEntitlementSnapshot(
    requireOrganizationId(req),
  );
  res.status(200).json(snapshot);
}
