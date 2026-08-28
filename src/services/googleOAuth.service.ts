import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import { hashPassword } from "../lib/password.js";
import { User } from "../models/User.model.js";
import { createSessionForUser } from "./auth.service.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** In-memory OAuth state (single-process MVP). Replace with Redis/DB for multi-instance. */
const pendingStates = new Map<
  string,
  { expiresAt: number; nextPath: string | null }
>();

function pruneStates(): void {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (value.expiresAt <= now) pendingStates.delete(key);
  }
}

export function assertGoogleOAuthConfigured(): void {
  if (!env.googleOAuth.enabled) {
    throw new AppError(
      503,
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      { code: "GOOGLE_OAUTH_DISABLED" },
    );
  }
}

export function createGoogleOAuthState(nextPath: string | null): string {
  pruneStates();
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, {
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    nextPath,
  });
  return state;
}

export function consumeGoogleOAuthState(state: string): string | null {
  pruneStates();
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) {
    throw new AppError(400, "Invalid or expired Google sign-in state", {
      code: "OAUTH_STATE_INVALID",
    });
  }
  return entry.nextPath;
}

export function buildGoogleAuthorizeUrl(state: string): string {
  assertGoogleOAuthConfigured();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.googleOAuth.clientId);
  url.searchParams.set("redirect_uri", env.googleOAuth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

type GoogleTokenResponse = {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
};

type GoogleUserInfo = {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  picture?: string;
};

async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: env.googleOAuth.clientId,
    client_secret: env.googleOAuth.clientSecret,
    redirect_uri: env.googleOAuth.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new AppError(401, "Google token exchange failed", {
      code: "GOOGLE_TOKEN_FAILED",
    });
  }

  return (await res.json()) as GoogleTokenResponse;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new AppError(401, "Failed to load Google profile", {
      code: "GOOGLE_PROFILE_FAILED",
    });
  }
  return (await res.json()) as GoogleUserInfo;
}

/**
 * Completes Google OAuth: link or create user, issue session cookie token.
 */
export async function completeGoogleOAuth(
  code: string,
  req: Request,
): Promise<{ rawSessionToken: string }> {
  assertGoogleOAuthConfigured();

  const tokens = await exchangeCodeForTokens(code);
  const profile = await fetchGoogleUserInfo(tokens.access_token);

  if (!profile.email || !profile.verified_email) {
    throw new AppError(403, "Google account email must be verified", {
      code: "GOOGLE_EMAIL_UNVERIFIED",
    });
  }

  const email = profile.email.toLowerCase().trim();
  let user = await User.findOne({ googleId: profile.id }).select(
    "+googleId +passwordHash",
  );

  if (!user) {
    user = await User.findOne({ email }).select("+googleId +passwordHash");
    if (user) {
      user.googleId = profile.id;
      if (!user.emailVerified) user.emailVerified = true;
      if (!user.authProvider) user.authProvider = "google";
      await user.save();
    } else {
      const randomSecret = createHash("sha256")
        .update(randomBytes(32))
        .digest("hex");
      const passwordHash = await hashPassword(randomSecret);
      user = await User.create({
        email,
        name: profile.name?.trim() || email.split("@")[0] || "User",
        passwordHash,
        emailVerified: true,
        googleId: profile.id,
        authProvider: "google",
        freeTrialUsed: false,
      });
    }
  }

  if (user.reinviteRequired) {
    throw new AppError(
      403,
      "Your previous workspace access was removed. Open a new invitation email to join again.",
      { code: "REINVITE_REQUIRED" },
    );
  }

  const rawSessionToken = await createSessionForUser(user._id.toString(), req);
  return { rawSessionToken };
}
