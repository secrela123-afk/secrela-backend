import { describe, expect, it } from "vitest";
import {
  OTP_FAILURES_BEFORE_LOCK,
  OTP_INITIAL_LOCK_MS,
  OTP_RESEND_COOLDOWN_MS,
  applyOtpVerifyFailure,
  isOtpResendCooldownActive,
  lockDurationMs,
} from "../otpGuard.js";

describe("otpGuard policy", () => {
  it("locks after three wrong codes with 15 minute initial ban", () => {
    let state = { failedAttempts: 0, banTier: 0, lockedUntil: null as Date | null };
    const now = Date.now();

    for (let i = 0; i < OTP_FAILURES_BEFORE_LOCK - 1; i += 1) {
      state = applyOtpVerifyFailure(state, now);
      expect(state.lockedUntil).toBeNull();
    }

    state = applyOtpVerifyFailure(state, now);
    expect(state.banTier).toBe(1);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).toBeTruthy();
    const lockMs = state.lockedUntil!.getTime() - now;
    expect(lockMs).toBe(OTP_INITIAL_LOCK_MS);
  });

  it("doubles lockout duration on the next three failures", () => {
    const now = Date.now();
    const state = applyOtpVerifyFailure(
      { failedAttempts: OTP_FAILURES_BEFORE_LOCK - 1, banTier: 1 },
      now,
    );

    expect(state.banTier).toBe(2);
    const lockMs = state.lockedUntil!.getTime() - now;
    expect(lockMs).toBe(OTP_INITIAL_LOCK_MS * 2);
  });

  it("enforces 30 minute resend cooldown", () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 60 * 1000);
    const expired = new Date(now - OTP_RESEND_COOLDOWN_MS - 1_000);

    expect(isOtpResendCooldownActive(recent, now)).toBe(true);
    expect(isOtpResendCooldownActive(expired, now)).toBe(false);
    expect(isOtpResendCooldownActive(null, now)).toBe(false);
  });

  it("computes escalating lock durations", () => {
    expect(lockDurationMs(0)).toBe(OTP_INITIAL_LOCK_MS);
    expect(lockDurationMs(1)).toBe(OTP_INITIAL_LOCK_MS * 2);
    expect(lockDurationMs(2)).toBe(OTP_INITIAL_LOCK_MS * 4);
  });
});
