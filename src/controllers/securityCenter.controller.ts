import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { getSecurityCenterForOrganization } from "../services/securityCenter.service.js";

function requireOrganizationId(req: Request): string {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.organizationId;
}

export async function getSecurityCenter(req: Request, res: Response) {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }
  const result = await getSecurityCenterForOrganization(
    requireOrganizationId(req),
  );
  res.status(200).json(result);
}
