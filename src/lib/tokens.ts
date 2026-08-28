import { createHash, randomBytes } from "node:crypto";

/** Opaque session / verification tokens — only the hash is stored in MongoDB. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
