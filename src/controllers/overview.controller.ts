import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { getOverviewForOrganization } from "../services/overview.service.js";

function requireOrganizationId(req: Request): string {
  if (!req.authMembership) {
    throw new AppError(500, "Membership context missing", {
      code: "INTERNAL_ERROR",
      isOperational: false,
    });
  }
  return req.authMembership.organizationId;
}

export async function getOverview(req: Request, res: Response) {
  if (!req.authUser || !req.authMembership) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const key = req.authMembership.systemKey;
  const isReviewer = key === "owner" || key === "admin";
  const canAudit = req.authMembership.permissions.includes("audit.read");

  const result = await getOverviewForOrganization(requireOrganizationId(req), {
    mayViewSecurityMetrics: isReviewer || canAudit,
    mayViewAccessRequests: isReviewer,
    mayViewAuditActivity: isReviewer || canAudit,
  });

  res.status(200).json(result);
}
