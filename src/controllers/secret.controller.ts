import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  CreateSecretBody,
  UpdateSecretBody,
} from "../schemas/secret.schemas.js";
import {
  auditContextFromRequest,
  recordAudit,
} from "../services/audit.service.js";
import {
  createSecretForOrganization,
  deleteSecretForOrganization,
  listSecretsForOrganization,
  revealSecretForOrganization,
  updateSecretForOrganization,
} from "../services/secret.service.js";

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
  const userId = requireUserId(req);
  const membership = req.authMembership;
  if (!membership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  const result = await listSecretsForOrganization(requireOrganizationId(req), {
    userId,
    permissions: membership.permissions,
  });
  res.status(200).json(result);
}

export async function create(req: Request, res: Response) {
  const membership = req.authMembership;
  if (!membership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  // MVP: only Owner/Admin may create secrets (custom roles use request-access flow).
  if (membership.systemKey !== "owner" && membership.systemKey !== "admin") {
    throw new AppError(403, "Only Owner or Admin can create secrets", {
      code: "FORBIDDEN",
    });
  }
  const organizationId = requireOrganizationId(req);
  const secret = await createSecretForOrganization(
    organizationId,
    requireUserId(req),
    req.body as CreateSecretBody,
    membership.permissions,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "secret.created",
    ...ctx,
    targetType: "secret",
    targetId: secret.id,
    targetLabel: secret.name,
  });
  res.status(201).json({ secret });
}

export async function update(req: Request, res: Response) {
  const membership = req.authMembership;
  if (!membership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  const organizationId = requireOrganizationId(req);
  const secret = await updateSecretForOrganization(
    organizationId,
    requireUserId(req),
    req.params.secretId as string,
    req.body as UpdateSecretBody,
    membership.permissions,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "secret.updated",
    ...ctx,
    targetType: "secret",
    targetId: secret.id,
    targetLabel: secret.name,
  });
  res.status(200).json({ secret });
}

export async function remove(req: Request, res: Response) {
  requireUserId(req);
  const organizationId = requireOrganizationId(req);
  const result = await deleteSecretForOrganization(
    organizationId,
    req.params.secretId as string,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "secret.deleted",
    ...ctx,
    targetType: "secret",
    targetId: result.deletedSecretId,
    targetLabel: result.name,
  });
  res.status(200).json({ deletedSecretId: result.deletedSecretId });
}

export async function reveal(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const result = await revealSecretForOrganization(
    organizationId,
    req.params.secretId as string,
    requireUserId(req),
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "secret.revealed",
    ...ctx,
    targetType: "secret",
    targetId: result.secretId,
    targetLabel: result.name,
  });
  res.status(200).json({ secretId: result.secretId, value: result.value });
}
