import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Envelope encryption helpers (AD-005 MVP).
 *
 * Platform KEK (env) wraps a per-organization DEK.
 * Secret values are encrypted with the org DEK.
 * KEK never goes into MongoDB. Secret plaintext never goes into MongoDB.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
export const SECRETS_KEY_VERSION = 1;

export type EncryptedBlob = {
  v: number;
  iv: string;
  tag: string;
  ct: string;
};

export class SecretsCryptoError extends Error {
  constructor(message = "Secrets crypto operation failed") {
    super(message);
    this.name = "SecretsCryptoError";
  }
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== "object") return false;
  const blob = value as EncryptedBlob;
  return (
    blob.v === SECRETS_KEY_VERSION &&
    typeof blob.iv === "string" &&
    typeof blob.tag === "string" &&
    typeof blob.ct === "string"
  );
}

function encryptWithKey(
  key: Buffer,
  plaintext: Buffer,
  aad: string,
): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: SECRETS_KEY_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

function decryptWithKey(key: Buffer, blob: EncryptedBlob, aad: string): Buffer {
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(blob.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.ct, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new SecretsCryptoError();
  }
}

/** Generate a fresh 32-byte DEK and wrap it with the platform KEK. */
export function generateWrappedDek(organizationId: string): EncryptedBlob {
  const dek = randomBytes(32);
  return encryptWithKey(env.secretsEncryptionKey, dek, `org:${organizationId}`);
}

export function unwrapDek(
  wrapped: unknown,
  organizationId: string,
): Buffer {
  if (!isEncryptedBlob(wrapped)) {
    throw new SecretsCryptoError("Organization DEK is missing or invalid");
  }
  const dek = decryptWithKey(
    env.secretsEncryptionKey,
    wrapped,
    `org:${organizationId}`,
  );
  if (dek.length !== 32) {
    throw new SecretsCryptoError("Unwrapped DEK has invalid length");
  }
  return dek;
}

export function encryptSecretValue(
  dek: Buffer,
  plaintext: string,
  secretId: string,
): EncryptedBlob {
  return encryptWithKey(dek, Buffer.from(plaintext, "utf8"), `secret:${secretId}`);
}

export function decryptSecretValue(
  dek: Buffer,
  blob: unknown,
  secretId: string,
): string {
  if (!isEncryptedBlob(blob)) {
    throw new SecretsCryptoError("Secret ciphertext is missing or invalid");
  }
  return decryptWithKey(dek, blob, `secret:${secretId}`).toString("utf8");
}
