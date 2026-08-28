import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import { isSessionFresh } from "../lib/sessionFreshness.js";
import type { RiskLevel } from "../lib/riskPolicy.js";
import { resolveSession } from "../services/auth.service.js";

async function attachSession(req: Request): Promise<void> {
  const rawToken = req.cookies?.[env.cookieName] as string | undefined;
  if (!rawToken) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const resolved = await resolveSession(rawToken, req);
  if (!resolved) {
    throw new AppError(401, "Invalid or expired session", {
      code: "SESSION_INVALID",
    });
  }

  req.authUser = resolved.user;
  req.authSession = {
    id: resolved.sessionId,
    userId: resolved.user.id,
    status: resolved.status ?? "full",
    authFreshAt: resolved.authFreshAt,
    authHighFreshAt: resolved.authHighFreshAt,
  };
}

function reauthRequired(level: RiskLevel, mfaEnabled: boolean): AppError {
  return new AppError(403, "Re-authentication required", {
    code: "REAUTH_REQUIRED",
    details: {
      level,
      mfaRequired: level === "high" && mfaEnabled,
    },
  });
}

/**
 * Any valid session cookie (full or MFA-pending). Used for logout / MFA verify.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await attachSession(req);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Fully authenticated session only. MFA-pending cookies cannot access /me etc.
 * Risk: LOW
 */
export async function requireFullAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await attachSession(req);
    if (req.authSession?.status !== "full") {
      throw new AppError(401, "MFA verification required", {
        code: "MFA_REQUIRED",
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Login password succeeded, waiting for TOTP / recovery code.
 */
export async function requireMfaPending(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await attachSession(req);
    if (req.authSession?.status !== "mfa_pending") {
      throw new AppError(400, "No MFA challenge is pending", {
        code: "MFA_CHALLENGE_MISSING",
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * MEDIUM risk — full session with recent password proof (authFreshAt).
 * Does NOT require TOTP even when MFA is enabled.
 */
export async function requireFreshAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await attachSession(req);
    if (req.authSession?.status !== "full") {
      throw new AppError(401, "MFA verification required", {
        code: "MFA_REQUIRED",
      });
    }
    if (!isSessionFresh(req.authSession.authFreshAt, env.stepUpTtlMs)) {
      throw reauthRequired("medium", req.authUser?.mfaEnabled ?? false);
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * HIGH risk — full session with recent high-step proof (authHighFreshAt).
 * That proof is password + TOTP/recovery when MFA is enabled; password only when MFA is off.
 */
export async function requireHighRiskAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    await attachSession(req);
    if (req.authSession?.status !== "full") {
      throw new AppError(401, "MFA verification required", {
        code: "MFA_REQUIRED",
      });
    }
    if (!isSessionFresh(req.authSession.authHighFreshAt, env.stepUpTtlMs)) {
      throw reauthRequired("high", req.authUser?.mfaEnabled ?? false);
    }
    next();
  } catch (err) {
    next(err);
  }
}
