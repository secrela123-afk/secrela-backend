import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  AcceptInvitationBody,
  CreateInvitationBody,
} from "../schemas/invitation.schemas.js";
import {
  auditContextFromRequest,
  recordAudit,
} from "../services/audit.service.js";
import {
  acceptInvitationForUser,
  acceptPendingInvitationForUser,
  createInvitationForOrganization,
  getInvitationPreviewByToken,
  getPendingInvitationForUser,
  listPendingInvitationsForOrganization,
  resendInvitationForOrganization,
  revokeInvitationForOrganization,
} from "../services/invitation.service.js";

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
  const body = req.body as CreateInvitationBody;
  const organizationId = requireOrganizationId(req);
  const invitation = await createInvitationForOrganization(
    requireUserId(req),
    organizationId,
    body,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "member.invited",
    ...ctx,
    targetType: "invitation",
    targetId: invitation.id,
    targetLabel: invitation.email,
  });
  res.status(201).json({ invitation });
}

export async function listPending(req: Request, res: Response) {
  const result = await listPendingInvitationsForOrganization(
    requireOrganizationId(req),
  );
  res.status(200).json(result);
}

export async function revoke(req: Request, res: Response) {
  const invitation = await revokeInvitationForOrganization(
    requireOrganizationId(req),
    req.params.invitationId as string,
  );
  res.status(200).json({ invitation });
}

export async function resend(req: Request, res: Response) {
  const invitation = await resendInvitationForOrganization(
    requireUserId(req),
    requireOrganizationId(req),
    req.params.invitationId as string,
  );
  res.status(200).json({ invitation });
}

/** Public — no auth cookie required. */
export async function preview(req: Request, res: Response) {
  const token = String(req.params.token ?? "");
  const result = await getInvitationPreviewByToken(token);
  if (result.reason === "invalid") {
    throw new AppError(404, "Invitation not found or invalid", {
      code: "INVITE_INVALID",
    });
  }
  res.status(200).json(result);
}

/** Authenticated accept. */
export async function accept(req: Request, res: Response) {
  const body = req.body as AcceptInvitationBody;
  const result = await acceptInvitationForUser(requireUserId(req), body.token);
  res.status(200).json(result);
}

/** Pending invite for current user email (after verify without invite token in URL). */
export async function pendingForMe(req: Request, res: Response) {
  const result = await getPendingInvitationForUser(requireUserId(req));
  res.status(200).json(result);
}

/** Accept pending invite by email match — no raw token required. */
export async function acceptPending(req: Request, res: Response) {
  const result = await acceptPendingInvitationForUser(requireUserId(req));
  res.status(200).json(result);
}
