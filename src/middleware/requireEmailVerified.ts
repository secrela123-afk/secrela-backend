import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors/AppError.js";

/**
 * Blocks API use until email is verified (session may still exist for /me + verify flow).
 */
export async function requireEmailVerified(
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
    if (!req.authUser.emailVerified) {
      throw new AppError(403, "Verify your email before continuing", {
        code: "EMAIL_NOT_VERIFIED",
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}
