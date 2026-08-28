import { AppError } from "./errors/AppError.js";
import { OtpGuard } from "../models/OtpGuard.model.js";

/** Minimum wait between OTP sends (resend). */
export const OTP_RESEND_COOLDOWN_MS = 30 * 60 * 1000;

/** Wrong codes allowed before a lockout window. */
export const OTP_FAILURES_BEFORE_LOCK = 3;

/** First lockout duration; doubles on each subsequent lockout tier. */
export const OTP_INITIAL_LOCK_MS = 15 * 60 * 1000;

export const OTP_SCOPES = {
  /** Global wrong-code lockout for all OTP verification flows. */
  VERIFY: "verify",
  /** Resend cooldown for MFA enable email codes. */
  MFA_ENABLE_SEND: "mfa_enable_send",
} as const;

export type OtpScope = (typeof OTP_SCOPES)[keyof typeof OTP_SCOPES];

function lockDurationMs(banTier: number): number {
  return OTP_INITIAL_LOCK_MS * 2 ** banTier;
}

export type OtpVerifyFailureState = {
  failedAttempts: number;
  banTier: number;
  lockedUntil: Date | null;
};

/** Pure helper — advances wrong-code counters and returns the next guard state. */
export function applyOtpVerifyFailure(
  state: Pick<OtpVerifyFailureState, "failedAttempts" | "banTier">,
  now = Date.now(),
): OtpVerifyFailureState {
  const nextAttempts = state.failedAttempts + 1;
  if (nextAttempts >= OTP_FAILURES_BEFORE_LOCK) {
    const duration = lockDurationMs(state.banTier);
    return {
      failedAttempts: 0,
      banTier: state.banTier + 1,
      lockedUntil: new Date(now + duration),
    };
  }
  return {
    failedAttempts: nextAttempts,
    banTier: state.banTier,
    lockedUntil: null,
  };
}

export function isOtpResendCooldownActive(
  lastSentAt: Date | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSentAt) return false;
  return now - lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS;
}

export { lockDurationMs };

function retryAfterSeconds(untilMs: number): number {
  return Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
}

function formatRetryLabel(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  if (minutes > 1) return `${minutes} minutes`;
  if (seconds >= 60) return "1 minute";
  return `${seconds} seconds`;
}

function otpLockedError(lockedUntil: Date): AppError {
  const seconds = retryAfterSeconds(lockedUntil.getTime());
  return new AppError(
    429,
    `Too many incorrect codes. Try again in ${formatRetryLabel(seconds)}.`,
    {
      code: "OTP_LOCKED",
      details: { retryAfterSeconds: seconds },
    },
  );
}

function otpResendCooldownError(lastSentAt: Date): AppError {
  const retryAt = lastSentAt.getTime() + OTP_RESEND_COOLDOWN_MS;
  const seconds = retryAfterSeconds(retryAt);
  return new AppError(
    429,
    `You can resend a code in ${formatRetryLabel(seconds)}.`,
    {
      code: "OTP_RESEND_COOLDOWN",
      details: { retryAfterSeconds: seconds },
    },
  );
}

async function getVerifyGuard(userId: string) {
  return OtpGuard.findOne({ userId, scope: OTP_SCOPES.VERIFY });
}

/** Block verification while an active lockout is in effect. */
export async function assertOtpVerifyAllowed(userId: string): Promise<void> {
  const guard = await getVerifyGuard(userId);
  if (!guard?.lockedUntil) return;

  if (guard.lockedUntil.getTime() > Date.now()) {
    throw otpLockedError(guard.lockedUntil);
  }
}

/**
 * Record a wrong OTP. After 3 failures → lockout (15m, then 30m, 60m, …).
 * Throws OTP_LOCKED when a new lockout starts or one is already active.
 */
export async function recordOtpVerifyFailure(userId: string): Promise<void> {
  let guard =
    (await OtpGuard.findOne({ userId, scope: OTP_SCOPES.VERIFY })) ??
    new OtpGuard({
      userId,
      scope: OTP_SCOPES.VERIFY,
      failedAttempts: 0,
      banTier: 0,
    });

  const now = Date.now();
  if (guard.lockedUntil && guard.lockedUntil.getTime() > now) {
    throw otpLockedError(guard.lockedUntil);
  }

  const next = applyOtpVerifyFailure(
    {
      failedAttempts: guard.failedAttempts,
      banTier: guard.banTier,
    },
    now,
  );
  guard.failedAttempts = next.failedAttempts;
  guard.banTier = next.banTier;
  guard.lockedUntil = next.lockedUntil;

  await guard.save();

  if (guard.lockedUntil && guard.lockedUntil.getTime() > now) {
    throw otpLockedError(guard.lockedUntil);
  }
}

/** Reset lockout state after a successful OTP verification. */
export async function clearOtpVerifySuccess(userId: string): Promise<void> {
  await OtpGuard.updateOne(
    { userId, scope: OTP_SCOPES.VERIFY },
    {
      $set: {
        failedAttempts: 0,
        banTier: 0,
        lockedUntil: null,
      },
    },
    { upsert: true },
  );
}

/** Enforce minimum delay between OTP sends for a scope. */
export async function assertOtpSendAllowed(
  userId: string,
  scope: OtpScope,
): Promise<void> {
  const guard = await OtpGuard.findOne({ userId, scope });
  if (!isOtpResendCooldownActive(guard?.lastSentAt ?? null)) return;
  throw otpResendCooldownError(guard!.lastSentAt!);
}

/** Record that an OTP was sent (starts resend cooldown). */
export async function recordOtpSent(
  userId: string,
  scope: OtpScope,
): Promise<void> {
  await OtpGuard.findOneAndUpdate(
    { userId, scope },
    { $set: { lastSentAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export function otpResendCooldownSeconds(): number {
  return Math.floor(OTP_RESEND_COOLDOWN_MS / 1000);
}
