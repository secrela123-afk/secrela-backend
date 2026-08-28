import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { Organization } from "../models/Organization.model.js";
import { assertActiveSubscription } from "../services/subscription.service.js";

/**
 * After requireMembership — blocks expired + pending_payment on workspace APIs.
 */
export async function requireActiveSubscription(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (!req.authMembership) {
      throw new AppError(500, "Membership context missing", {
        code: "INTERNAL_ERROR",
        isOperational: false,
      });
    }

    const organization = await Organization.findById(
      req.authMembership.organizationId,
    );
    if (!organization) {
      throw new AppError(404, "Organization no longer exists", {
        code: "ORGANIZATION_NOT_FOUND",
      });
    }

    await assertActiveSubscription(organization);
    next();
  } catch (err) {
    next(err);
  }
}
