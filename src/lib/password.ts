import argon2 from "argon2";

/**
 * Password hashing with Argon2id (OWASP-recommended family for passwords).
 * Never store or log plaintext passwords.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyPassword(
  passwordHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, plaintext);
  } catch {
    return false;
  }
}

/** Used when email is unknown so login timing stays closer across paths. */
let dummyPasswordHash: string | undefined;

export async function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = await hashPassword(
      "__securevault_dummy_password_not_a_user__",
    );
  }
  return dummyPasswordHash;
}
