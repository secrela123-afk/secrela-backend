/**
 * Unit tests need env() without a real MongoDB connection.
 * Must run synchronously at load time (not in beforeAll) so env.ts can read them.
 * Values are test-only — never use in production.
 */
process.env.MONGODB_URI ??=
  "mongodb://127.0.0.1:27017/securevault-test";
process.env.TOTP_ENCRYPTION_KEY ??=
  Buffer.alloc(32, 7).toString("base64");
process.env.APP_NAME ??= "Secrela";
process.env.STEP_UP_TTL_MINUTES ??= "10";
