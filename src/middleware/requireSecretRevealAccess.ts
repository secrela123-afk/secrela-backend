import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { permissionsInclude } from "../lib/permissions.js";
import { hasActiveTemporarySecretAccess } from "../services/accessRequest.service.js";

/**
 * Allow reveal when the member has permanent `secret.reveal`
 * OR an active approved temporary grant for this secret.
 */
export async function requireSecretRevealAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const membership = req.authMembership;
    if (!membership) {
      throw new AppError(500, "Membership context missing", {
        code: "INTERNAL_ERROR",
        isOperational: false,
      });
    }

    if (permissionsInclude(membership.permissions, "secret.reveal")) {
      next();
      return;
    }

    const secretId = req.params.secretId as string;
    const allowed = await hasActiveTemporarySecretAccess(
      membership.organizationId,
      membership.userId,
      secretId,
    );

    if (!allowed) {
      throw new AppError(
        403,
        "You need reveal permission or an approved temporary access grant",
        {
          code: "FORBIDDEN",
          details: { permission: "secret.reveal|temporary_grant" },
        },
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}
