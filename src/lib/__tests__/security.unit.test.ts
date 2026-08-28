import { describe, expect, it } from "vitest";
import { isSessionFresh, toDualSessionFreshness } from "../sessionFreshness.js";
import {
  findMatchingRecoveryHash,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from "../recoveryCodes.js";
import { RISK_POLICY, OPERATION_RISK } from "../riskPolicy.js";
import { hashToken } from "../tokens.js";
import { generateTotpSecret, isTotpCode, verifyTotpCode } from "../totp.js";
import { Secret, TOTP } from "otpauth";

describe("session freshness", () => {
  it("rejects null authFreshAt", () => {
    expect(isSessionFresh(null, 10 * 60_000)).toBe(false);
  });

  it("accepts recent authFreshAt within TTL", () => {
    expect(isSessionFresh(new Date(), 10 * 60_000)).toBe(true);
  });

  it("rejects stale authFreshAt", () => {
    const stale = new Date(Date.now() - 11 * 60_000);
    expect(isSessionFresh(stale, 10 * 60_000)).toBe(false);
  });

  it("exposes medium and high freshness separately", () => {
    const mediumAt = new Date();
    const highAt = new Date(Date.now() - 11 * 60_000);
    const dual = toDualSessionFreshness(mediumAt, highAt, 10 * 60_000);
    expect(dual.medium.fresh).toBe(true);
    expect(dual.high.fresh).toBe(false);
    expect(dual.fresh).toBe(true);
  });
});

describe("recovery codes", () => {
  it("stores hashes only — plaintext is not in hash list", () => {
    const { plaintext, hashes } = generateRecoveryCodes();
    expect(plaintext).toHaveLength(8);
    expect(hashes).toHaveLength(8);
    for (const code of plaintext) {
      expect(hashes).not.toContain(code);
      expect(hashes).toContain(hashToken(normalizeRecoveryCode(code)));
    }
  });

  it("matches a code once conceptually (hash lookup)", () => {
    const { plaintext, hashes } = generateRecoveryCodes();
    const code = plaintext[0]!;
    const match = findMatchingRecoveryHash(hashes, code);
    expect(match).toBeDefined();
    const remaining = hashes.filter((h: string) => h !== match);
    expect(findMatchingRecoveryHash(remaining, code)).toBeUndefined();
  });
});

describe("risk policy", () => {
  it("defines LOW / MEDIUM / HIGH", () => {
    expect(RISK_POLICY.low.passwordFresh).toBe(false);
    expect(RISK_POLICY.medium.passwordFresh).toBe(true);
    expect(RISK_POLICY.medium.mfaFactorWhenEnabled).toBe(false);
    expect(RISK_POLICY.high.mfaFactorWhenEnabled).toBe(true);
  });

  it("maps secret reveal and MFA disable to HIGH", () => {
    expect(OPERATION_RISK.secretReveal).toBe("high");
    expect(OPERATION_RISK.mfaDisable).toBe("high");
    expect(OPERATION_RISK.mfaSetup).toBe("medium");
  });
});

describe("TOTP helpers", () => {
  it("isTotpCode accepts 6 digits only", () => {
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("abcd-efgh")).toBe(false);
  });

  it("verifies a live TOTP against otpauth library", () => {
    const secret = generateTotpSecret();
    const email = "test@example.com";
    const totp = new TOTP({
      issuer: "Secrela",
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });
    const token = totp.generate();
    expect(verifyTotpCode(secret, token, email)).toBe(true);
    expect(verifyTotpCode(secret, "000000", email)).toBe(false);
  });
});
