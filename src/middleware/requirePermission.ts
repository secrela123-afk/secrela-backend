import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AppError } from "../lib/errors/AppError.js";
import {
  permissionsInclude,
  type Permission,
} from "../lib/permissions.js";
import {
  Membership,
  type MembershipStatus,
} from "../models/Membership.model.js";
import { resolveRoleForMembership } from "../services/role.service.js";
import type { AuthMembership } from "../types/auth.js";

export type { AuthMembership };

/**
 * Loads the caller's organization membership + resolved Role onto the request.
 * Must run after requireFullAuth (needs req.authUser).
 */
export async function requireMembership(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required", {
        code: "UNAUTHENTICATED",
      });
    }

    const membership = await Membership.findOne({
      userId: req.authUser.id,
    });

    if (!membership) {
      throw new AppError(404, "No organization found for this account", {
        code: "NO_ORGANIZATION",
      });
    }

    const status = (membership.status ?? "active") as MembershipStatus;
    if (status === "disabled") {
      throw new AppError(
        403,
        "Your account has been disabled by an organization admin",
        {
          code: "MEMBER_DISABLED",
        },
      );
    }

    const resolved = await resolveRoleForMembership(membership);
    if (!membership.roleId || membership.roleId.toString() !== resolved.roleId) {
      membership.roleId = new mongoose.Types.ObjectId(resolved.roleId);
      await membership.save();
    }

    req.authMembership = {
      id: membership._id.toString(),
      organizationId: membership.organizationId.toString(),
      userId: membership.userId.toString(),
      roleId: resolved.roleId,
      roleName: resolved.name,
      systemKey: resolved.systemKey,
      permissions: resolved.permissions,
      status,
      role: resolved.systemKey ?? resolved.name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * RBAC gate — user must have the given permission via their Role document.
 * Chain: requireFullAuth → requireMembership → requirePermission("…")
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const membership = req.authMembership;
      if (!membership) {
        throw new AppError(500, "Membership context missing", {
          code: "INTERNAL_ERROR",
          isOperational: false,
        });
      }

      if (!permissionsInclude(membership.permissions, permission)) {
        throw new AppError(403, "You do not have permission for this action", {
          code: "FORBIDDEN",
          details: {
            permission,
            roleId: membership.roleId,
            roleName: membership.roleName,
          },
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
