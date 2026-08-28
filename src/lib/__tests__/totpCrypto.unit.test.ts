import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  process.env.MONGODB_URI ??=
    "mongodb://127.0.0.1:27017/securevault-test";
  process.env.TOTP_ENCRYPTION_KEY ??=
    Buffer.alloc(32, 7).toString("base64");
});

describe("TOTP AES-256-GCM at rest", () => {
  it("round-trips and never stores plaintext in the blob", async () => {
    const { encryptTotpSecret, decryptTotpSecret, isEncryptedTotpSecret } =
      await import("../totpCrypto.js");

    const secret = "JBSWY3DPEHPK3PXP";
    const userId = "507f1f77bcf86cd799439011";
    const blob = encryptTotpSecret(secret, userId);

    expect(isEncryptedTotpSecret(blob)).toBe(true);
    expect(JSON.stringify(blob)).not.toContain(secret);
    expect(decryptTotpSecret(blob, userId)).toBe(secret);
  });

  it("rejects decrypt with wrong user AAD", async () => {
    const { encryptTotpSecret, decryptTotpSecret, TotpCryptoError } =
      await import("../totpCrypto.js");

    const blob = encryptTotpSecret("JBSWY3DPEHPK3PXP", "user-a");
    expect(() => decryptTotpSecret(blob, "user-b")).toThrow(TotpCryptoError);
  });
});
