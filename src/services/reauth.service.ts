import { env } from "../config/env.js";
import { AppError } from "../lib/errors/AppError.js";
import { verifyPassword } from "../lib/password.js";
import {
  toDualSessionFreshness,
  type DualSessionFreshness,
} from "../lib/sessionFreshness.js";
import { Session } from "../models/Session.model.js";
import { User } from "../models/User.model.js";
import {
  assertOtpVerifyAllowed,
  clearOtpVerifySuccess,
  recordOtpVerifyFailure,
} from "../lib/otpGuard.js";
import { isTotpCode } from "../lib/totp.js";
import { consumeMfaFactor, verifyTotpForUser } from "./mfa.service.js";

export type ReauthLevel = "medium" | "high";

function reauthFailed(): AppError {
  return new AppError(401, "Re-authentication failed", {
    code: "REAUTH_FAILED",
  });
}

/**
 * Step-up re-authentication on an existing full session.
 *
 * MEDIUM — password only (refreshes authFreshAt)
 * HIGH   — password + TOTP/recovery when MFA enabled (refreshes both clocks)
 *          If MFA is off, password alone refreshes both clocks.
 */
export async function reauthenticateSession(
  userId: string,
  sessionId: string,
  password: string,
  code: string | undefined,
  level: ReauthLevel = "medium",
): Promise<DualSessionFreshness> {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user?.passwordHash) {
    throw reauthFailed();
  }

  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    throw reauthFailed();
  }

  const now = new Date();
  const setFields: { authFreshAt: Date; authHighFreshAt?: Date } = {
    authFreshAt: now,
  };

  if (level === "high") {
    if (user.mfaEnabled) {
      if (!code) {
        throw new AppError(400, "Authenticator or recovery code required", {
          code: "MFA_CODE_REQUIRED",
          details: { level: "high", mfaRequired: true },
        });
      }

      await assertOtpVerifyAllowed(userId);

      // Accept live TOTP or one-time recovery code for high-risk step-up.
      if (isTotpCode(code)) {
        const validTotp = await verifyTotpForUser(userId, code);
        if (!validTotp) {
          await recordOtpVerifyFailure(userId);
          throw reauthFailed();
        }
        await clearOtpVerifySuccess(userId);
      } else {
        await consumeMfaFactor(userId, code);
      }
    }

    setFields.authHighFreshAt = now;
  }

  const updated = await Session.updateOne(
    { _id: sessionId, userId, revokedAt: null },
    { $set: setFields },
  );

  if (updated.matchedCount === 0) {
    throw new AppError(401, "Invalid or expired session", {
      code: "SESSION_INVALID",
    });
  }

  const session = await Session.findById(sessionId).lean();
  return toDualSessionFreshness(
    session?.authFreshAt ?? now,
    session?.authHighFreshAt ?? null,
    env.stepUpTtlMs,
  );
}
