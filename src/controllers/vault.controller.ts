import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  CreateVaultBody,
  UpdateVaultBody,
} from "../schemas/vault.schemas.js";
import {
  auditContextFromRequest,
  recordAudit,
} from "../services/audit.service.js";
import {
  createVaultForOrganization,
  deleteVaultForOrganization,
  getVaultForOrganization,
  listVaultsForOrganization,
  updateVaultForOrganization,
} from "../services/vault.service.js";

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
  const result = await listVaultsForOrganization(requireOrganizationId(req));
  res.status(200).json(result);
}

export async function getOne(req: Request, res: Response) {
  requireUserId(req);
  const vault = await getVaultForOrganization(
    requireOrganizationId(req),
    req.params.vaultId as string,
  );
  res.status(200).json({ vault });
}

export async function create(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const vault = await createVaultForOrganization(
    organizationId,
    requireUserId(req),
    req.body as CreateVaultBody,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "vault.created",
    ...ctx,
    targetType: "vault",
    targetId: vault.id,
    targetLabel: vault.name,
  });
  res.status(201).json({ vault });
}

export async function update(req: Request, res: Response) {
  const organizationId = requireOrganizationId(req);
  const vault = await updateVaultForOrganization(
    organizationId,
    requireUserId(req),
    req.params.vaultId as string,
    req.body as UpdateVaultBody,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "vault.updated",
    ...ctx,
    targetType: "vault",
    targetId: vault.id,
    targetLabel: vault.name,
  });
  res.status(200).json({ vault });
}

export async function remove(req: Request, res: Response) {
  requireUserId(req);
  const organizationId = requireOrganizationId(req);
  const result = await deleteVaultForOrganization(
    organizationId,
    req.params.vaultId as string,
  );
  const ctx = auditContextFromRequest(req);
  void recordAudit({
    organizationId,
    action: "vault.deleted",
    ...ctx,
    targetType: "vault",
    targetId: result.deletedVaultId,
    targetLabel: result.name,
  });
  res.status(200).json({ deletedVaultId: result.deletedVaultId });
}
