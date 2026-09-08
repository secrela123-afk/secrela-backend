/**
 * Creem REST API — current card checkout (Merchant of Record).
 * Lemon Squeezy stays in lemonSqueezy.ts but is not on the live checkout path.
 * Docs: https://docs.creem.io
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./errors/AppError.js";
import type { BillingInterval, PaidPlanSlug } from "./subscriptionPlans.js";

function apiBase(): string {
  return env.creem.mode === "live"
    ? "https://api.creem.io/v1"
    : "https://test-api.creem.io/v1";
}

function requireConfigured(): void {
  if (!env.creem.configured) {
    throw new AppError(
      503,
      "Creem is not configured. Set CREEM_API_KEY and CREEM_PRODUCT_* in backend/.env.",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
}

function creemErrorDetail(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const rec = json as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  const rec = asRecord(value);
  if (typeof rec.id === "string" && rec.id.trim()) return rec.id.trim();
  return "";
}

export async function creemFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  requireConfigured();

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": env.creem.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.error("[securevault-api] creem fetch failed:", err);
    throw new AppError(
      502,
      "Could not reach Creem from the server. Check outbound HTTPS and CREEM_API_KEY.",
      { code: "CREEM_NETWORK_ERROR" },
    );
  }

  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const detail = creemErrorDetail(json);
    throw new AppError(
      502,
      detail
        ? `Creem: ${detail}`
        : `Creem request failed (${res.status}). Check API key, test/live mode, and product IDs.`,
      { code: "CREEM_API_ERROR" },
    );
  }

  return json;
}

export type CreateCreemCheckoutInput = {
  productId: string;
  email?: string;
  name?: string;
  successUrl: string;
  metadata: Record<string, string>;
};

export async function createCreemCheckout(
  input: CreateCreemCheckoutInput,
): Promise<{ checkoutUrl: string; checkoutId: string }> {
  const json = asRecord(
    await creemFetch("POST", "/checkouts", {
      product_id: input.productId,
      success_url: input.successUrl,
      request_id: `${input.metadata.organizationId}:${input.metadata.planSlug}:${input.metadata.interval}:${Date.now()}`,
      customer: {
        email: input.email ?? "",
        name: input.name ?? "",
      },
      metadata: input.metadata,
    }),
  );

  const checkoutUrl = String(
    json.checkout_url ?? json.checkoutUrl ?? "",
  ).trim();
  const checkoutId = asId(json.id);
  if (!checkoutId || !checkoutUrl) {
    throw new AppError(502, "Creem did not return a checkout URL", {
      code: "CREEM_CHECKOUT_MISSING",
    });
  }
  return { checkoutUrl, checkoutId };
}

export async function retrieveCreemCheckout(
  checkoutId: string,
): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(checkoutId);
  return asRecord(
    await creemFetch("GET", `/checkouts?checkout_id=${id}`),
  );
}

export async function retrieveCreemCustomerByEmail(
  email: string,
): Promise<Record<string, unknown> | null> {
  const json = await creemFetch(
    "GET",
    `/customers?email=${encodeURIComponent(email)}`,
  );
  const rec = asRecord(json);
  if (asId(rec.id)) return rec;
  const items =
    (Array.isArray(rec.items) ? rec.items : null) ??
    (Array.isArray(asRecord(rec.result).items)
      ? (asRecord(rec.result).items as unknown[])
      : null) ??
    (Array.isArray(json) ? json : null);
  if (!items || items.length === 0) return null;
  const first = asRecord(items[0]);
  return asId(first.id) ? first : null;
}

export async function createCreemCustomerPortalUrl(
  customerId: string,
): Promise<string | null> {
  const json = asRecord(
    await creemFetch("POST", "/customers/billing", {
      customer_id: customerId,
    }),
  );
  const url = String(
    json.customer_portal_link ?? json.customerPortalLink ?? "",
  ).trim();
  return url || null;
}

export async function cancelCreemSubscription(
  subscriptionId: string,
): Promise<void> {
  await creemFetch(
    "POST",
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { mode: "immediate" },
  );
}

export function productIdForPlan(
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): string {
  const p = env.creem.products;
  const byPlan = {
    starter: { monthly: p.starterMonthly, yearly: p.starterYearly },
    team: { monthly: p.teamMonthly, yearly: p.teamYearly },
    business: { monthly: p.businessMonthly, yearly: p.businessYearly },
  } as const;
  return byPlan[planSlug][interval];
}

export function planFromCreemProductId(
  productId: string,
): { planSlug: PaidPlanSlug; interval: BillingInterval } | null {
  const id = productId.trim();
  if (!id) return null;
  const p = env.creem.products;
  const rows: Array<{
    id: string;
    planSlug: PaidPlanSlug;
    interval: BillingInterval;
  }> = [
    { id: p.starterMonthly, planSlug: "starter", interval: "monthly" },
    { id: p.starterYearly, planSlug: "starter", interval: "yearly" },
    { id: p.teamMonthly, planSlug: "team", interval: "monthly" },
    { id: p.teamYearly, planSlug: "team", interval: "yearly" },
    { id: p.businessMonthly, planSlug: "business", interval: "monthly" },
    { id: p.businessYearly, planSlug: "business", interval: "yearly" },
  ];
  return rows.find((row) => row.id && row.id === id) ?? null;
}

export function metadataFromUnknown(
  value: unknown,
): Record<string, string> {
  const rec = asRecord(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function verifyCreemWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = env.creem.webhookSecret;
  if (!secret || !signatureHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
