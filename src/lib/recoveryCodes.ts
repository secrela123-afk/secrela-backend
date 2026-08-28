import { randomBytes } from "node:crypto";
import { hashToken } from "./tokens.js";

const CODE_COUNT = 8;

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[-\s]/g, "").toLowerCase();
}

export function formatRecoveryCode(rawHex: string): string {
  const normalized = normalizeRecoveryCode(rawHex);
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

/**
 * Recovery codes are shown once in plaintext, then stored as SHA-256 hashes.
 * They are high-entropy one-time backups if the authenticator is lost.
 */
export function generateRecoveryCodes(): {
  plaintext: string[];
  hashes: string[];
} {
  const plaintext: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < CODE_COUNT; i += 1) {
    const raw = randomBytes(4).toString("hex");
    const display = formatRecoveryCode(raw);
    plaintext.push(display);
    hashes.push(hashToken(normalizeRecoveryCode(display)));
  }

  return { plaintext, hashes };
}

export function findMatchingRecoveryHash(
  hashes: string[],
  submitted: string,
): string | undefined {
  const submittedHash = hashToken(normalizeRecoveryCode(submitted));
  return hashes.find((hash) => hash === submittedHash);
}
