import type { CookieOptions, Response } from "express";
import { env } from "../config/env.js";

export function sessionCookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
    path: "/",
    maxAge: maxAgeMs ?? env.sessionTtlMs,
  };
}

export function setSessionCookie(
  res: Response,
  rawToken: string,
  maxAgeMs?: number,
): void {
  res.cookie(env.cookieName, rawToken, sessionCookieOptions(maxAgeMs));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.cookieName, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
    path: "/",
  });
}
