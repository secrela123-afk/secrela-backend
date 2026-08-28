import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * AES-256-GCM for TOTP secrets at rest.
 * This is encryption (reversible with the key), not hashing.
 * We must decrypt to verify codes — hashing would make TOTP unusable.
 *
 * The key (TOTP_ENCRYPTION_KEY) stays outside MongoDB.
 * AAD binds ciphertext to the user id so a blob cannot be copied onto another user.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
export const TOTP_KEY_VERSION = 1;

export type EncryptedTotpSecret = {
  v: number;
  iv: string;
  tag: string;
  ct: string;
};

export class TotpCryptoError extends Error {
  constructor(message = "TOTP secret decrypt failed") {
    super(message);
    this.name = "TotpCryptoError";
  }
}

export function isEncryptedTotpSecret(
  value: unknown,
): value is EncryptedTotpSecret {
  if (!value || typeof value !== "object") return false;
  const blob = value as EncryptedTotpSecret;
  return (
    blob.v === TOTP_KEY_VERSION &&
    typeof blob.iv === "string" &&
    typeof blob.tag === "string" &&
    typeof blob.ct === "string"
  );
}

export function encryptTotpSecret(
  plaintext: string,
  userId: string,
): EncryptedTotpSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, env.totpEncryptionKey, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    v: TOTP_KEY_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

export function decryptTotpSecret(
  blob: unknown,
  userId: string,
): string {
  if (!isEncryptedTotpSecret(blob)) {
    throw new TotpCryptoError();
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      env.totpEncryptionKey,
      Buffer.from(blob.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TotpCryptoError();
  }
}
