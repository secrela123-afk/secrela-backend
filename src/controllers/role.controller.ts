import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import type {
  CreateRoleBody,
  UpdateRoleBody,
} from "../schemas/organization.schemas.js";
import {
  createCustomRole,
  deleteCustomRole,
  listRolesForOrganization,
  updateCustomRole,
} from "../services/role.service.js";

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

function requireActorPermissions(req: Request): readonly string[] {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.permissions;
}

export async function list(req: Request, res: Response) {
  requireUserId(req);
  const result = await listRolesForOrganization(requireOrganizationId(req));
  res.status(200).json(result);
}

export async function create(req: Request, res: Response) {
  requireUserId(req);
  const body = req.body as CreateRoleBody;
  const role = await createCustomRole({
    organizationId: requireOrganizationId(req),
    actorPermissions: requireActorPermissions(req),
    name: body.name,
    description: body.description,
    permissions: body.permissions,
  });
  res.status(201).json({ role });
}

export async function update(req: Request, res: Response) {
  requireUserId(req);
  const body = req.body as UpdateRoleBody;
  const role = await updateCustomRole({
    organizationId: requireOrganizationId(req),
    roleId: req.params.roleId as string,
    actorPermissions: requireActorPermissions(req),
    name: body.name,
    description: body.description,
    permissions: body.permissions,
  });
  res.status(200).json({ role });
}

export async function remove(req: Request, res: Response) {
  requireUserId(req);
  const result = await deleteCustomRole({
    organizationId: requireOrganizationId(req),
    roleId: req.params.roleId as string,
    actorPermissions: requireActorPermissions(req),
  });
  res.status(200).json(result);
}
