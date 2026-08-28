import type { Request } from "express";
import { AppError } from "../lib/errors/AppError.js";
import { hashPassword } from "../lib/password.js";
import { getRequestClientMeta } from "../lib/requestClient.js";
import { generateOpaqueToken, hashToken } from "../lib/tokens.js";
import { User } from "../models/User.model.js";
import type {
  ForgotPasswordBody,
  ResetPasswordBody,
} from "../schemas/auth.schemas.js";
import { logoutAllSessions } from "./auth.service.js";
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "./email.service.js";

/** Matches the "15 min" callout on the forgot-password screen. */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;

const GENERIC_RESET_MESSAGE =
  "If an account exists for that email, a password reset link has been sent.";

export async function requestPasswordReset(
  input: ForgotPasswordBody,
): Promise<{ message: string }> {
  const email = input.email.toLowerCase().trim();
  const user = await User.findOne({ email }).select(
    "+passwordResetTokenHash +passwordResetExpiresAt",
  );

  if (!user) {
    return { message: GENERIC_RESET_MESSAGE };
  }

  const rawToken = generateOpaqueToken();
  user.passwordResetTokenHash = hashToken(rawToken);
  user.passwordResetExpiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  await user.save();

  await sendPasswordResetEmail(email, user.name, rawToken);

  return { message: GENERIC_RESET_MESSAGE };
}

export async function resetPasswordWithToken(
  input: ResetPasswordBody,
  req: Request,
): Promise<{ message: string }> {
  const tokenHash = hashToken(input.token);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordHash");

  if (!user) {
    throw new AppError(400, "Invalid or expired reset link", {
      code: "INVALID_RESET_TOKEN",
    });
  }

  user.passwordHash = await hashPassword(input.password);
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  await user.save();

  await logoutAllSessions(user._id.toString());

  const { ip, userAgent } = getRequestClientMeta(req);
  void sendPasswordChangedEmail(user.email, user.name, {
    ip,
    userAgent,
    changedAt: new Date(),
  });

  return { message: "Password updated. You can sign in with your new password." };
}
