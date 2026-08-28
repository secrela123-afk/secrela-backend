import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  CreateAccessRequestBody,
  ReviewAccessRequestBody,
} from "../schemas/accessRequest.schemas.js";
import {
  auditContextFromRequest,
  recordAudit,
} from "../services/audit.service.js";
import {
  approveAccessRequestForOrganization,
  createAccessRequestForOrganization,
  denyAccessRequestForOrganization,
  listAccessRequestsForOrganization,
  revokeAccessRequestForOrganization,
} from "../services/accessRequest.service.js";

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

export async function list(req: Request, res: Response) {
  requireUserId(req);
  const result = await listAccessRequestsForOrganization(
    requireOrganizationId(req),
  );
  res.status(200).json(result);
}

export async function create(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const request = await createAccessRequestForOrganization(
    organizationId,
    requireUserId(req),
    req.body as CreateAccessRequestBody,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "access.requested",
    ...ctx,
    targetType: "access_request",
    targetId: request.id,
    targetLabel: request.secret.name,
    metadata: {
      secretId: request.secret.id,
      durationMinutes: request.durationMinutes,
    },
  });
  res.status(201).json({ request });
}

export async function approve(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const request = await approveAccessRequestForOrganization(
    organizationId,
    requireUserId(req),
    req.params.requestId as string,
    req.body as ReviewAccessRequestBody,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "access.approved",
    ...ctx,
    targetType: "access_request",
    targetId: request.id,
    targetLabel: request.secret.name,
    metadata: {
      requesterId: request.requester.id,
      secretId: request.secret.id,
    },
  });
  res.status(200).json({ request });
}

export async function deny(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const request = await denyAccessRequestForOrganization(
    organizationId,
    requireUserId(req),
    req.params.requestId as string,
    req.body as ReviewAccessRequestBody,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "access.denied",
    ...ctx,
    targetType: "access_request",
    targetId: request.id,
    targetLabel: request.secret.name,
    metadata: {
      requesterId: request.requester.id,
      secretId: request.secret.id,
    },
  });
  res.status(200).json({ request });
}

export async function revoke(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const request = await revokeAccessRequestForOrganization(
    organizationId,
    requireUserId(req),
    req.params.requestId as string,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "access.revoked",
    ...ctx,
    targetType: "access_request",
    targetId: request.id,
    targetLabel: request.secret.name,
  });
  res.status(200).json({ request });
}
