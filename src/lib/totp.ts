import { env } from "../config/env.js";
import { Secret, TOTP } from "otpauth";

/**
 * TOTP (Time-based One-Time Password) — the 6-digit codes from apps like
 * Google Authenticator / Authy. We use the standard library `otpauth`
 * (RFC 6238). No custom cryptography.
 */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function createTotp(secretBase32: string, accountLabel: string): TOTP {
  return new TOTP({
    issuer: env.appName,
    label: accountLabel,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function getOtpauthUri(secretBase32: string, email: string): string {
  return createTotp(secretBase32, email).toString();
}

export function verifyTotpCode(
  secretBase32: string,
  code: string,
  email: string,
): boolean {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;

  const delta = createTotp(secretBase32, email).validate({
    token,
    window: 1,
  });

  return delta !== null;
}

export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ""));
}
