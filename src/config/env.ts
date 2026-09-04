/**
 * Environment configuration for the API.
 * Loads backend/.env from known paths so Google/SMTP keys work whether the
 * process starts from `backend/` or the monorepo root.
 * Real secrets must never be committed — use .env locally (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

function resolveEnvFile(): string | null {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "backend/.env"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

{
  const envFile = resolveEnvFile();
  const fromFile: Record<string, string> = {};
  if (envFile) {
    // Isolated parse so we can fill empty inherited vars
    // (dotenv skips keys that already exist on process.env — even if blank).
    dotenv.config({ path: envFile, processEnv: fromFile });
    dotenv.config({ path: envFile });
  } else {
    dotenv.config();
  }

  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ] as const) {
    const current = process.env[key];
    if ((!current || !current.trim()) && fromFile[key]) {
      process.env[key] = fromFile[key];
    }
  }
}

function requirePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseCorsOrigins(value: string | undefined): string[] {
  const raw = value ?? "http://localhost:3010";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requireMongodbUri(value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(
      "MONGODB_URI is required. Copy backend/.env.example to backend/.env and set it.",
    );
  }
  return value.trim();
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function parseSameSite(
  value: string | undefined,
): "lax" | "strict" | "none" {
  const v = (value ?? "lax").toLowerCase();
  if (v === "lax" || v === "strict" || v === "none") return v;
  throw new Error(`Invalid COOKIE_SAMESITE: ${value}`);
}

/**
 * 32-byte AES-256 key, base64-encoded. Lives in env — never in MongoDB.
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function requireAes256Key(value: string | undefined, label: string): Buffer {
  if (!value || !value.trim()) {
    throw new Error(
      `${label} is required (32-byte key, base64). Copy backend/.env.example to backend/.env and generate a key.`,
    );
  }

  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`${label} must decode to exactly 32 bytes (AES-256).`);
  }

  return key;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`Invalid boolean env value: ${value}`);
}

function parseSmtpPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SMTP_PORT: ${value}`);
  }
  return port;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

const smtpUser = process.env.SMTP_USER?.trim() ?? "";
const smtpPass = process.env.SMTP_PASS?.trim() ?? "";
const emailEnabled = parseBoolean(
  process.env.EMAIL_ENABLED,
  Boolean(smtpUser && smtpPass),
);

if (isProduction && !emailEnabled) {
  throw new Error(
    "EMAIL_ENABLED must be true in production (verification / reset / invites).",
  );
}

if (emailEnabled && (!smtpUser || !smtpPass)) {
  throw new Error(
    "EMAIL_ENABLED=true but SMTP_USER or SMTP_PASS is missing in backend/.env",
  );
}

const appName = process.env.APP_NAME ?? "Secrela";

const totpEncryptionKey = requireAes256Key(
  process.env.TOTP_ENCRYPTION_KEY,
  "TOTP_ENCRYPTION_KEY",
);

/**
 * Platform KEK for wrapping per-organization DEKs (AD-005).
 * Required and distinct from TOTP key in production.
 */
function resolveSecretsEncryptionKey(): Buffer {
  const dedicated = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (dedicated) {
    return requireAes256Key(dedicated, "SECRETS_ENCRYPTION_KEY");
  }
  if (isProduction) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is required in production and must differ from TOTP_ENCRYPTION_KEY.",
    );
  }
  // Local MVP convenience only — never reuse in production.
  return totpEncryptionKey;
}

const secretsEncryptionKey = resolveSecretsEncryptionKey();

if (
  isProduction &&
  secretsEncryptionKey.equals(totpEncryptionKey)
) {
  throw new Error(
    "SECRETS_ENCRYPTION_KEY must be a different key from TOTP_ENCRYPTION_KEY in production.",
  );
}

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
const googleRedirectUri =
  process.env.GOOGLE_REDIRECT_URI?.trim() ||
  `http://localhost:5005/api/v1/auth/oauth/google/callback`;

export const env = {
  nodeEnv,
  port: requirePort(process.env.PORT, 5005),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  mongodbUri: requireMongodbUri(process.env.MONGODB_URI),
  appOrigin: (process.env.APP_ORIGIN ?? "http://localhost:3010").replace(/\/$/, ""),
  appName,
  cookieName: process.env.SESSION_COOKIE_NAME ?? "sv_session",
  /** Session lifetime in milliseconds (default 7 days). */
  sessionTtlMs:
    parsePositiveInt(process.env.SESSION_TTL_HOURS, 168, "SESSION_TTL_HOURS") *
    60 *
    60 *
    1000,
  cookieSecure:
    process.env.COOKIE_SECURE === "true" ||
    (process.env.COOKIE_SECURE !== "false" && isProduction),
  cookieSameSite: parseSameSite(process.env.COOKIE_SAMESITE),
  totpEncryptionKey,
  secretsEncryptionKey,
  /** How long a session stays "fresh" after login or re-auth (default 10 min). */
  stepUpTtlMs:
    parsePositiveInt(
      process.env.STEP_UP_TTL_MINUTES,
      10,
      "STEP_UP_TTL_MINUTES",
    ) *
    60 *
    1000,
  email: {
    enabled: emailEnabled,
    smtpHost: process.env.SMTP_HOST?.trim() || "smtp-relay.brevo.com",
    smtpPort: parseSmtpPort(process.env.SMTP_PORT, 587),
    smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
    smtpUser,
    smtpPass,
    from:
      process.env.EMAIL_FROM?.trim() ||
      `${appName} <${smtpUser || "noreply@secrela.local"}>`,
  },
  googleOAuth: {
    enabled: Boolean(googleClientId && googleClientSecret),
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: googleRedirectUri,
  },
  /**
   * Lemon Squeezy (Merchant of Record).
   * When apiKey + storeId + variant IDs are set, checkout uses real card payments.
   * Recurring billing is handled by Lemon; we sync via webhooks.
   */
  lemonSqueezy: (() => {
    const apiKey = process.env.LEMON_SQUEEZY_API_KEY?.trim() ?? "";
    const storeId = process.env.LEMON_SQUEEZY_STORE_ID?.trim() ?? "";
    const webhookSecret =
      process.env.LEMON_SQUEEZY_WEBHOOK_SECRET?.trim() ?? "";
    const variants = {
      starterMonthly:
        process.env.LEMON_SQUEEZY_VARIANT_STARTER_MONTHLY?.trim() ?? "",
      starterYearly:
        process.env.LEMON_SQUEEZY_VARIANT_STARTER_YEARLY?.trim() ?? "",
      teamMonthly: process.env.LEMON_SQUEEZY_VARIANT_TEAM_MONTHLY?.trim() ?? "",
      teamYearly: process.env.LEMON_SQUEEZY_VARIANT_TEAM_YEARLY?.trim() ?? "",
      businessMonthly:
        process.env.LEMON_SQUEEZY_VARIANT_BUSINESS_MONTHLY?.trim() ?? "",
      businessYearly:
        process.env.LEMON_SQUEEZY_VARIANT_BUSINESS_YEARLY?.trim() ?? "",
    };
    const configured = Boolean(
      apiKey &&
        storeId &&
        variants.starterMonthly &&
        variants.starterYearly &&
        variants.teamMonthly &&
        variants.teamYearly,
    );
    return {
      configured,
      apiKey,
      storeId,
      webhookSecret,
      variants,
      /** Dev-only DB activate — must be explicitly `true`; never default on in development. */
      allowMockActivate: parseBoolean(
        process.env.LEMON_SQUEEZY_ALLOW_MOCK_ACTIVATE,
        false,
      ),
    };
  })(),
  /**
   * PayPal Subscriptions (current checkout provider).
   * Sandbox vs live is PAYPAL_MODE. Plan IDs come from the PayPal dashboard.
   */
  paypal: (() => {
    const clientId = process.env.PAYPAL_CLIENT_ID?.trim() ?? "";
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
    const modeRaw = (process.env.PAYPAL_MODE ?? "sandbox").toLowerCase();
    const mode: "sandbox" | "live" = modeRaw === "live" ? "live" : "sandbox";
    const plans = {
      starterMonthly: process.env.PAYPAL_PLAN_STARTER_MONTHLY?.trim() ?? "",
      starterYearly: process.env.PAYPAL_PLAN_STARTER_YEARLY?.trim() ?? "",
      teamMonthly: process.env.PAYPAL_PLAN_TEAM_MONTHLY?.trim() ?? "",
      teamYearly: process.env.PAYPAL_PLAN_TEAM_YEARLY?.trim() ?? "",
      businessMonthly: process.env.PAYPAL_PLAN_BUSINESS_MONTHLY?.trim() ?? "",
      businessYearly: process.env.PAYPAL_PLAN_BUSINESS_YEARLY?.trim() ?? "",
    };
    const configured = Boolean(
      clientId &&
        clientSecret &&
        plans.starterMonthly &&
        plans.starterYearly &&
        plans.teamMonthly &&
        plans.teamYearly,
    );
    return {
      configured,
      clientId,
      clientSecret,
      mode,
      webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() ?? "",
      plans,
      allowMockActivate: parseBoolean(
        process.env.PAYPAL_ALLOW_MOCK_ACTIVATE,
        false,
      ),
    };
  })(),
  /**
   * Paddle Billing — card overlay (no PayPal account). PayPal stays the other option.
   * Sandbox dashboard: https://sandbox-vendors.paddle.com
   */
  paddle: (() => {
    const apiKey = process.env.PADDLE_API_KEY?.trim() ?? "";
    const clientToken = process.env.PADDLE_CLIENT_TOKEN?.trim() ?? "";
    const modeRaw = (process.env.PADDLE_MODE ?? "sandbox").toLowerCase();
    const mode: "sandbox" | "live" = modeRaw === "live" ? "live" : "sandbox";
    const prices = {
      starterMonthly: process.env.PADDLE_PRICE_STARTER_MONTHLY?.trim() ?? "",
      starterYearly: process.env.PADDLE_PRICE_STARTER_YEARLY?.trim() ?? "",
      teamMonthly: process.env.PADDLE_PRICE_TEAM_MONTHLY?.trim() ?? "",
      teamYearly: process.env.PADDLE_PRICE_TEAM_YEARLY?.trim() ?? "",
      businessMonthly: process.env.PADDLE_PRICE_BUSINESS_MONTHLY?.trim() ?? "",
      businessYearly: process.env.PADDLE_PRICE_BUSINESS_YEARLY?.trim() ?? "",
    };
    const configured = Boolean(
      apiKey &&
        clientToken &&
        prices.starterMonthly &&
        prices.starterYearly &&
        prices.teamMonthly &&
        prices.teamYearly,
    );
    return {
      configured,
      apiKey,
      clientToken,
      mode,
      webhookSecret: process.env.PADDLE_WEBHOOK_SECRET?.trim() ?? "",
      prices,
    };
  })(),
  /**
   * Trust X-Forwarded-For / X-Real-IP only behind a known reverse proxy.
   * Default: true in production, false in development (avoids spoofing).
   */
  trustProxy: parseBoolean(process.env.TRUST_PROXY, isProduction),
} as const;
