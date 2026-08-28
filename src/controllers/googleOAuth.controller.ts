import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import { setSessionCookie } from "../lib/cookies.js";
import {
  buildGoogleAuthorizeUrl,
  completeGoogleOAuth,
  consumeGoogleOAuthState,
  createGoogleOAuthState,
} from "../services/googleOAuth.service.js";

function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }
  return raw;
}

/**
 * GET /api/v1/auth/oauth/google?next=/app
 * Redirects browser to Google consent screen.
 */
export async function googleStart(req: Request, res: Response) {
  const nextPath = safeNextPath(req.query.next);
  const state = createGoogleOAuthState(nextPath);
  const url = buildGoogleAuthorizeUrl(state);
  res.redirect(302, url);
}

/**
 * GET /api/v1/auth/oauth/google/callback
 * Exchanges code, creates session cookie, redirects to app.
 */
export async function googleCallback(req: Request, res: Response) {
  const error = typeof req.query.error === "string" ? req.query.error : null;
  if (error) {
    res.redirect(
      302,
      `${env.appOrigin}/login?oauth_error=${encodeURIComponent(error)}`,
    );
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) {
    throw new AppError(400, "Missing Google OAuth code or state", {
      code: "OAUTH_CALLBACK_INVALID",
    });
  }

  const nextFromState = consumeGoogleOAuthState(state);
  const { rawSessionToken } = await completeGoogleOAuth(code, req);
  setSessionCookie(res, rawSessionToken);

  const dest = nextFromState || "/app";
  res.redirect(302, `${env.appOrigin}${dest}`);
}
