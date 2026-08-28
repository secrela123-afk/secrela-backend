import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as authController from "../../controllers/auth.controller.js";
import * as googleOAuthController from "../../controllers/googleOAuth.controller.js";
import * as mfaController from "../../controllers/mfa.controller.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import {
  requireFreshAuth,
  requireFullAuth,
  requireHighRiskAuth,
  requireMfaPending,
} from "../../middleware/requireAuth.js";
import { requireDatabase } from "../../middleware/requireDatabase.js";
import { validateBody } from "../../middleware/validateBody.js";
import {
  forgotPasswordBodySchema,
  loginBodySchema,
  mfaCodeBodySchema,
  mfaEnableStartBodySchema,
  mfaEnableVerifyEmailBodySchema,
  reauthenticateBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  verifyEmailBodySchema,
} from "../../schemas/auth.schemas.js";

/**
 * Auth routes — sessions via HttpOnly cookie (not JWT in browser storage).
 *
 * Risk mapping (see lib/riskPolicy.ts):
 *   LOW    → requireFullAuth
 *   MEDIUM → requireFreshAuth
 *   HIGH   → requireHighRiskAuth
 */
export const authRouter = Router();

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many auth attempts. Try again later.",
    },
  },
});

const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many MFA attempts. Try again later.",
    },
  },
});

authRouter.post(
  "/register",
  requireDatabase,
  authRateLimiter,
  validateBody(registerBodySchema),
  asyncHandler(authController.register),
);

authRouter.post(
  "/login",
  requireDatabase,
  authRateLimiter,
  validateBody(loginBodySchema),
  asyncHandler(authController.login),
);

authRouter.get(
  "/oauth/google",
  requireDatabase,
  authRateLimiter,
  asyncHandler(googleOAuthController.googleStart),
);

authRouter.get(
  "/oauth/google/callback",
  requireDatabase,
  authRateLimiter,
  asyncHandler(googleOAuthController.googleCallback),
);

authRouter.post("/logout", asyncHandler(authController.logout));

authRouter.post(
  "/logout-all",
  requireHighRiskAuth,
  asyncHandler(authController.logoutAll),
);

authRouter.get("/me", requireFullAuth, asyncHandler(authController.me));

authRouter.post(
  "/reauthenticate",
  requireFullAuth,
  authRateLimiter,
  validateBody(reauthenticateBodySchema),
  asyncHandler(authController.reauthenticate),
);

authRouter.post(
  "/verify-email",
  authRateLimiter,
  validateBody(verifyEmailBodySchema),
  asyncHandler(authController.verifyEmail),
);

authRouter.post(
  "/forgot-password",
  authRateLimiter,
  validateBody(forgotPasswordBodySchema),
  asyncHandler(authController.forgotPassword),
);

authRouter.post(
  "/reset-password",
  authRateLimiter,
  validateBody(resetPasswordBodySchema),
  asyncHandler(authController.resetPassword),
);

authRouter.get(
  "/mfa/status",
  requireFullAuth,
  asyncHandler(mfaController.status),
);

/** Enable wizard step 1 — password + send email OTP (no freshness gate; password is the proof) */
authRouter.post(
  "/mfa/enable/start",
  requireFullAuth,
  mfaVerifyLimiter,
  validateBody(mfaEnableStartBodySchema),
  asyncHandler(mfaController.enableStart),
);

/** Enable wizard step 2 — verify email OTP */
authRouter.post(
  "/mfa/enable/verify-email",
  requireFullAuth,
  mfaVerifyLimiter,
  validateBody(mfaEnableVerifyEmailBodySchema),
  asyncHandler(mfaController.enableVerifyEmail),
);

/** MEDIUM — start TOTP enrollment (requires prior email OTP authorization) */
authRouter.post(
  "/mfa/setup",
  requireFreshAuth,
  asyncHandler(mfaController.setup),
);

/** MEDIUM — confirm enrollment with first TOTP (setup already fresh-gated) */
authRouter.post(
  "/mfa/enable",
  requireFreshAuth,
  mfaVerifyLimiter,
  validateBody(mfaCodeBodySchema),
  asyncHandler(mfaController.enable),
);

/** HIGH — disable MFA */
authRouter.post(
  "/mfa/disable",
  requireHighRiskAuth,
  mfaVerifyLimiter,
  validateBody(mfaCodeBodySchema),
  asyncHandler(mfaController.disable),
);

/** HIGH — regenerate recovery codes */
authRouter.post(
  "/mfa/recovery/regenerate",
  requireHighRiskAuth,
  mfaVerifyLimiter,
  validateBody(mfaCodeBodySchema),
  asyncHandler(mfaController.regenerate),
);

authRouter.post(
  "/mfa/verify",
  requireMfaPending,
  mfaVerifyLimiter,
  validateBody(mfaCodeBodySchema),
  asyncHandler(mfaController.verify),
);
