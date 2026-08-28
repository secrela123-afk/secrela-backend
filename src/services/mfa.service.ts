import type { Request } from "express";
import { randomInt } from "node:crypto";
import { AppError } from "../lib/errors/AppError.js";
import { verifyPassword } from "../lib/password.js";
import {
  findMatchingRecoveryHash,
  generateRecoveryCodes,
} from "../lib/recoveryCodes.js";
import { hashToken } from "../lib/tokens.js";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  TotpCryptoError,
} from "../lib/totpCrypto.js";
import {
  generateTotpSecret,
  getOtpauthUri,
  isTotpCode,
  verifyTotpCode,
} from "../lib/totp.js";
import { User } from "../models/User.model.js";
import { Session } from "../models/Session.model.js";
import { toAuthUser, type AuthUser } from "../types/auth.js";
import {
  assertOtpSendAllowed,
  assertOtpVerifyAllowed,
  clearOtpVerifySuccess,
  otpResendCooldownSeconds,
  OTP_SCOPES,
  recordOtpSent,
  recordOtpVerifyFailure,
} from "../lib/otpGuard.js";
import { createSessionForUser } from "./auth.service.js";
import { sendMfaEnableEmailCode } from "./email.service.js";

const MFA_SECRET_FIELDS =
  "+totpSecretEnc +totpPendingSecretEnc +recoveryCodeHashes";

const MFA_ENABLE_FIELDS =
  "+passwordHash +mfaEnableEmailCodeHash +mfaEnableEmailExpiresAt +mfaSetupAuthorizedUntil";

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const SETUP_AUTH_TTL_MS = 15 * 60 * 1000;

function invalidMfaCode(): AppError {
  return new AppError(401, "Invalid authentication code", {
    code: "INVALID_MFA_CODE",
  });
}

async function rejectWrongOtp(userId: string): Promise<never> {
  await recordOtpVerifyFailure(userId);
  throw invalidMfaCode();
}

function totpDecryptFailed(): AppError {
  return new AppError(500, "An unexpected error occurred", {
    code: "INTERNAL_ERROR",
    isOperational: false,
  });
}

function readTotpSecret(blob: unknown, userId: string): string {
  try {
    return decryptTotpSecret(blob, userId);
  } catch (err) {
    if (err instanceof TotpCryptoError) {
      throw totpDecryptFailed();
    }
    throw err;
  }
}

function clearMfaEnableChallenge(user: {
  set: (path: string, val: unknown) => void;
}) {
  user.set("mfaEnableEmailCodeHash", null);
  user.set("mfaEnableEmailExpiresAt", null);
}

async function assertMfaSetupAuthorized(userId: string): Promise<void> {
  const user = await User.findById(userId).select("+mfaSetupAuthorizedUntil");
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }
  if (
    !user.mfaSetupAuthorizedUntil ||
    user.mfaSetupAuthorizedUntil.getTime() < Date.now()
  ) {
    throw new AppError(403, "Confirm your email code to continue MFA setup", {
      code: "MFA_EMAIL_CONFIRM_REQUIRED",
    });
  }
}

/**
 * Step 1 of enable wizard: verify email+password, send email OTP, refresh MEDIUM freshness.
 */
export async function beginMfaEnableChallenge(
  userId: string,
  sessionId: string,
  input: { email: string; password: string },
): Promise<{
  sentTo: string;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
}> {
  await assertOtpSendAllowed(userId, OTP_SCOPES.MFA_ENABLE_SEND);

  const user = await User.findById(userId).select(MFA_ENABLE_FIELDS);
  if (!user?.passwordHash) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (user.mfaEnabled) {
    throw new AppError(409, "MFA is already enabled", {
      code: "MFA_ALREADY_ENABLED",
    });
  }

  if (input.email.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError(400, "Email does not match this account", {
      code: "EMAIL_MISMATCH",
    });
  }

  const validPassword = await verifyPassword(user.passwordHash, input.password);
  if (!validPassword) {
    throw new AppError(401, "Invalid email or password", {
      code: "REAUTH_FAILED",
    });
  }

  const code = String(randomInt(100_000, 1_000_000));
  user.mfaEnableEmailCodeHash = hashToken(code);
  user.mfaEnableEmailExpiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);
  user.set("mfaSetupAuthorizedUntil", null);
  await user.save();

  await Session.updateOne(
    { _id: sessionId, userId, revokedAt: null },
    { $set: { authFreshAt: new Date() } },
  );

  await sendMfaEnableEmailCode(user.email, user.name, code);
  await recordOtpSent(userId, OTP_SCOPES.MFA_ENABLE_SEND);

  return {
    sentTo: user.email,
    expiresInSeconds: Math.floor(EMAIL_CODE_TTL_MS / 1000),
    resendAvailableInSeconds: otpResendCooldownSeconds(),
  };
}

/**
 * Step 2: verify email OTP → authorize authenticator setup window.
 */
export async function verifyMfaEnableEmailCode(
  userId: string,
  code: string,
): Promise<{ authorizedUntil: string }> {
  const user = await User.findById(userId).select(MFA_ENABLE_FIELDS);
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (user.mfaEnabled) {
    throw new AppError(409, "MFA is already enabled", {
      code: "MFA_ALREADY_ENABLED",
    });
  }

  await assertOtpVerifyAllowed(userId);

  if (
    !user.mfaEnableEmailCodeHash ||
    !user.mfaEnableEmailExpiresAt ||
    user.mfaEnableEmailExpiresAt.getTime() < Date.now()
  ) {
    throw new AppError(400, "Email code expired. Request a new one.", {
      code: "MFA_EMAIL_CODE_EXPIRED",
    });
  }

  const submitted = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(submitted)) {
    throw new AppError(400, "Enter the 6-digit email code", {
      code: "INVALID_MFA_CODE",
    });
  }

  if (hashToken(submitted) !== user.mfaEnableEmailCodeHash) {
    await rejectWrongOtp(userId);
  }

  const authorizedUntil = new Date(Date.now() + SETUP_AUTH_TTL_MS);
  user.mfaSetupAuthorizedUntil = authorizedUntil;
  clearMfaEnableChallenge(user);
  await user.save();
  await clearOtpVerifySuccess(userId);

  return { authorizedUntil: authorizedUntil.toISOString() };
}

export async function startMfaSetup(userId: string): Promise<{
  secret: string;
  otpauthUri: string;
}> {
  await assertMfaSetupAuthorized(userId);

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (user.mfaEnabled) {
    throw new AppError(409, "MFA is already enabled", {
      code: "MFA_ALREADY_ENABLED",
    });
  }

  const secret = generateTotpSecret();
  user.totpPendingSecretEnc = encryptTotpSecret(secret, userId);
  await user.save();

  return {
    secret,
    otpauthUri: getOtpauthUri(secret, user.email),
  };
}

export async function enableMfa(
  userId: string,
  code: string,
): Promise<{ user: AuthUser; recoveryCodes: string[] }> {
  await assertMfaSetupAuthorized(userId);

  const user = await User.findById(userId).select(
    `${MFA_SECRET_FIELDS} +mfaSetupAuthorizedUntil`,
  );
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  if (user.mfaEnabled) {
    throw new AppError(409, "MFA is already enabled", {
      code: "MFA_ALREADY_ENABLED",
    });
  }

  if (!user.totpPendingSecretEnc) {
    throw new AppError(400, "Start MFA setup first", {
      code: "MFA_SETUP_REQUIRED",
    });
  }

  await assertOtpVerifyAllowed(userId);

  const pendingSecret = readTotpSecret(user.totpPendingSecretEnc, userId);
  if (!verifyTotpCode(pendingSecret, code, user.email)) {
    await rejectWrongOtp(userId);
  }

  const recovery = generateRecoveryCodes();
  user.totpSecretEnc = encryptTotpSecret(pendingSecret, userId);
  user.set("totpPendingSecretEnc", null);
  user.set("mfaSetupAuthorizedUntil", null);
  clearMfaEnableChallenge(user);
  user.mfaEnabled = true;
  user.recoveryCodeHashes = recovery.hashes;
  await user.save();
  await clearOtpVerifySuccess(userId);

  return {
    recoveryCodes: recovery.plaintext,
    user: toAuthUser({
      _id: user._id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      createdAt: user.createdAt,
    }),
  };
}

export async function consumeMfaFactor(
  userId: string,
  code: string,
): Promise<void> {
  const user = await User.findById(userId).select(MFA_SECRET_FIELDS);
  if (!user || !user.mfaEnabled || !user.totpSecretEnc) {
    throw new AppError(400, "MFA is not enabled", {
      code: "MFA_NOT_ENABLED",
    });
  }

  await assertOtpVerifyAllowed(userId);

  if (isTotpCode(code)) {
    const secret = readTotpSecret(user.totpSecretEnc, userId);
    if (!verifyTotpCode(secret, code, user.email)) {
      await rejectWrongOtp(userId);
    }
    await clearOtpVerifySuccess(userId);
    return;
  }

  const match = findMatchingRecoveryHash(user.recoveryCodeHashes ?? [], code);
  if (!match) {
    await rejectWrongOtp(userId);
  }

  user.recoveryCodeHashes = (user.recoveryCodeHashes ?? []).filter(
    (hash) => hash !== match,
  );
  await user.save();
  await clearOtpVerifySuccess(userId);
}

export async function disableMfa(
  userId: string,
  code: string,
): Promise<AuthUser> {
  await consumeMfaFactor(userId, code);

  const user = await User.findById(userId).select(MFA_SECRET_FIELDS);
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  user.mfaEnabled = false;
  user.set("totpSecretEnc", null);
  user.set("totpPendingSecretEnc", null);
  user.set("mfaSetupAuthorizedUntil", null);
  user.set("mfaEnableEmailCodeHash", null);
  user.set("mfaEnableEmailExpiresAt", null);
  user.recoveryCodeHashes = [];
  await user.save();

  return toAuthUser({
    _id: user._id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt,
  });
}

export async function regenerateRecoveryCodes(
  userId: string,
  code: string,
): Promise<string[]> {
  const user = await User.findById(userId).select(MFA_SECRET_FIELDS);
  if (!user || !user.mfaEnabled || !user.totpSecretEnc) {
    throw new AppError(400, "MFA is not enabled", {
      code: "MFA_NOT_ENABLED",
    });
  }

  await assertOtpVerifyAllowed(userId);

  const secret = readTotpSecret(user.totpSecretEnc, userId);
  if (!verifyTotpCode(secret, code, user.email)) {
    await rejectWrongOtp(userId);
  }

  const recovery = generateRecoveryCodes();
  user.recoveryCodeHashes = recovery.hashes;
  await user.save();
  await clearOtpVerifySuccess(userId);
  return recovery.plaintext;
}

export async function getMfaStatus(userId: string): Promise<{
  enabled: boolean;
  recoveryCodesRemaining: number;
}> {
  const user = await User.findById(userId).select("+recoveryCodeHashes");
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  return {
    enabled: user.mfaEnabled,
    recoveryCodesRemaining: user.mfaEnabled
      ? (user.recoveryCodeHashes ?? []).length
      : 0,
  };
}

export async function verifyTotpForUser(
  userId: string,
  code: string,
): Promise<boolean> {
  const user = await User.findById(userId).select("+totpSecretEnc");
  if (!user?.mfaEnabled || !user.totpSecretEnc) return false;
  if (!isTotpCode(code)) return false;

  const secret = readTotpSecret(user.totpSecretEnc, userId);
  return verifyTotpCode(secret, code, user.email);
}

export async function completeMfaLogin(
  userId: string,
  pendingSessionId: string,
  code: string,
  req: Request,
): Promise<{ user: AuthUser; rawSessionToken: string }> {
  await consumeMfaFactor(userId, code);

  await Session.updateOne(
    { _id: pendingSessionId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError(401, "Authentication required", {
      code: "UNAUTHENTICATED",
    });
  }

  const rawSessionToken = await createSessionForUser(userId, req, {
    status: "full",
  });

  return {
    rawSessionToken,
    user: toAuthUser({
      _id: user._id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      createdAt: user.createdAt,
    }),
  };
}
