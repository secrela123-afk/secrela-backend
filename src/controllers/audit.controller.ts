import type { Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import {
  listAuditLogsForOrganization,
  requireAuditOrganizationId,
} from "../services/audit.service.js";

export async function list(req: Request, res: Response) {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const action =
    typeof req.query.action === "string" && req.query.action.trim()
      ? req.query.action.trim()
      : undefined;
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === "string" && Number.isFinite(Number(limitRaw))
      ? Number(limitRaw)
      : undefined;

  const result = await listAuditLogsForOrganization(
    requireAuditOrganizationId(req),
    { action, limit },
  );
  res.status(200).json(result);
}
