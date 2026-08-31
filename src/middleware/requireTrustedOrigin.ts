import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for cookie sessions (AD-003):
 * - SameSite cookie (lax by default) blocks most cross-site POSTs
 * - Mutating requests must send Origin/Referer matching CORS allowlist
 *   (or no Origin for same-origin navigations that still send Referer)
 *
 * Full double-submit CSRF tokens can be added later; Origin check covers
 * the classic cross-site form CSRF case for our JSON API.
 */
export function requireTrustedOrigin(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    // PayPal webhooks are server-to-server (no browser Origin).
    // Authenticity is verified via PayPal's webhook signature API.
    const path = req.originalUrl.split("?")[0] ?? "";
    if (
      req.method.toUpperCase() === "POST" &&
      (path.endsWith("/billing/webhooks/paypal") ||
        path.endsWith("/billing/webhooks/paddle"))
    ) {
      next();
      return;
    }

    const origin = req.get("origin");
    const referer = req.get("referer");

    if (origin) {
      if (!env.corsOrigins.includes(origin)) {
        throw new AppError(403, "Untrusted request origin", {
          code: "CSRF_ORIGIN_REJECTED",
        });
      }
      next();
      return;
    }

    if (referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (env.corsOrigins.includes(refOrigin)) {
          next();
          return;
        }
      } catch {
        /* fall through */
      }
      throw new AppError(403, "Untrusted request referer", {
        code: "CSRF_ORIGIN_REJECTED",
      });
    }

    // Non-browser clients (curl, Postman) often omit Origin — allow in development.
    if (env.nodeEnv !== "production") {
      next();
      return;
    }

    throw new AppError(403, "Missing Origin header on mutating request", {
      code: "CSRF_ORIGIN_REQUIRED",
    });
  } catch (err) {
    next(err);
  }
}
