/**
 * Paddle Billing REST (sandbox or live).
 * Overlay checkout: we create a transaction, the browser opens Paddle.js.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./errors/AppError.js";

function apiBase(): string {
  return env.paddle.mode === "live"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

function requireConfigured(): void {
  if (!env.paddle.configured) {
    throw new AppError(
      503,
      "Paddle is not configured. Set PADDLE_API_KEY, PADDLE_CLIENT_TOKEN, and the four PADDLE_PRICE_* ids.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
}

export function paddlePriceIdFor(
  planSlug: "starter" | "team",
  interval: "monthly" | "yearly",
): string {
  const p = env.paddle.prices;
  if (planSlug === "starter" && interval === "monthly") return p.starterMonthly;
  if (planSlug === "starter" && interval === "yearly") return p.starterYearly;
  if (planSlug === "team" && interval === "monthly") return p.teamMonthly;
  return p.teamYearly;
}

export function paddlePublicConfig(): {
  configured: boolean;
  clientToken: string;
  environment: "sandbox" | "production";
} {
  return {
    configured: env.paddle.configured,
    clientToken: env.paddle.clientToken,
    environment: env.paddle.mode === "live" ? "production" : "sandbox",
  };
}

async function paddleRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  requireConfigured();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.paddle.apiKey}`,
      "Content-Type": "application/json",
      "Paddle-Version": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & {
    error?: { detail?: string; code?: string; type?: string };
  };
  if (!res.ok) {
    const detail = json.error?.detail?.trim();
    const code = json.error?.code ?? "";
    console.error(
      `[paddle] ${method} ${path} → ${res.status} ${code} ${detail ?? ""}`,
    );
    const message =
      code === "transaction_default_checkout_url_not_set"
        ? "Paddle needs a default payment link. In sandbox: Checkout → Checkout settings → Default payment link → http://localhost:3010/checkout → Save. Then try Pay again."
        : detail
          ? `Paddle: ${detail}`
          : "Paddle request failed. Check API key, price ids, sandbox vs live, and default checkout URL.";
    throw new AppError(502, message, { code: "PADDLE_API_ERROR" });
  }
  return json;
}

export async function createPaddleTransaction(input: {
  priceId: string;
  organizationId: string;
  planSlug: string;
  interval: string;
}): Promise<{ transactionId: string }> {
  const json = await paddleRequest<{ data?: { id?: string } }>(
    "POST",
    "/transactions",
    {
      items: [{ price_id: input.priceId, quantity: 1 }],
      custom_data: {
        organizationId: input.organizationId,
        planSlug: input.planSlug,
        interval: input.interval,
      },
    },
  );
  const transactionId = json.data?.id?.trim() ?? "";
  if (!transactionId) {
    throw new AppError(502, "Paddle did not return a transaction id", {
      code: "PADDLE_TRANSACTION_MISSING",
    });
  }
  return { transactionId };
}

export type PaddleTransaction = {
  id?: string;
  status?: string;
  custom_data?: {
    organizationId?: string;
    planSlug?: string;
    interval?: string;
  } | null;
  details?: { totals?: { grand_total?: string } };
  payments?: Array<{ method_details?: { card?: { type?: string; last4?: string } } }>;
};

export async function getPaddleTransaction(
  transactionId: string,
): Promise<PaddleTransaction> {
  const json = await paddleRequest<{ data?: PaddleTransaction }>(
    "GET",
    `/transactions/${encodeURIComponent(transactionId)}`,
  );
  if (!json.data?.id) {
    throw new AppError(404, "Paddle transaction not found", {
      code: "PADDLE_TRANSACTION_MISSING",
    });
  }
  return json.data;
}

export function verifyPaddleWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = env.paddle.webhookSecret;
  if (!secret || !signatureHeader) return false;
  const parts = new Map(
    signatureHeader.split(";").map((piece) => {
      const idx = piece.indexOf("=");
      if (idx < 0) return ["", ""] as const;
      return [piece.slice(0, idx).trim(), piece.slice(idx + 1).trim()] as const;
    }),
  );
  const ts = parts.get("ts") ?? "";
  const h1 = parts.get("h1") ?? "";
  if (!ts || !h1) return false;
  const digest = createHmac("sha256", secret)
    .update(`${ts}:${rawBody}`)
    .digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(h1, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function paddleGrandTotalCents(txn: PaddleTransaction): number | null {
  const raw = txn.details?.totals?.grand_total;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}
