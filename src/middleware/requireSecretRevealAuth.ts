/**
 * Placeholder for future secret-reveal HIGH-risk gate.
 *
 * When vault secret encryption (AD-005) ships, reveal endpoints must use:
 *   requireHighRiskAuth
 *
 * Do NOT decrypt or return plaintext secrets until:
 * 1. Envelope encryption + KEK lifecycle is implemented
 * 2. Organization-scoped authorization is checked
 * 3. HIGH step-up freshness is confirmed
 * 4. The reveal is audited (metadata only — never log plaintext)
 *
 * This module documents the boundary; it does not invent crypto.
 */
import type { NextFunction, Request, Response } from "express";
import { requireHighRiskAuth } from "./requireAuth.js";

/**
 * Alias kept for readability at secret-reveal routes.
 * Equivalent to requireHighRiskAuth (HIGH risk policy).
 */
export const requireSecretRevealAuth = requireHighRiskAuth;

/** Example stack for a future POST /secrets/:id/reveal route. */
export async function secretRevealAuthStack(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  return requireHighRiskAuth(req, res, next);
}
