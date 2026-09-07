/**
 * Lemon Squeezy REST (JSON:API) — current card checkout provider.
 * PayPal and Paddle stay in the repo but are not on the live checkout path.
 * Docs: https://docs.lemonsqueezy.com/api
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./errors/AppError.js";
import type { BillingInterval, PaidPlanSlug } from "./subscriptionPlans.js";

const API_BASE = "https://api.lemonsqueezy.com/v1";

type JsonApiResource = {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

type JsonApiResponse = {
  data: JsonApiResource;
  meta?: Record<string, unknown>;
};

function requireConfigured(): void {
  if (!env.lemonSqueezy.configured) {
    throw new AppError(
      503,
      "Lemon Squeezy is not configured. Set LEMON_SQUEEZY_* env vars (see .env.example).",
      { code: "BILLING_PROVIDER_NOT_CONFIGURED" },
    );
  }
}

function lemonErrorDetail(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const errors = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (!first || typeof first !== "object") return null;
  const detail = (first as { detail?: unknown; title?: unknown }).detail;
  const title = (first as { detail?: unknown; title?: unknown }).title;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (typeof title === "string" && title.trim()) return title.trim();
  return null;
}

async function lemonFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  requireConfigured();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${env.lemonSqueezy.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.error("[securevault-api] lemon fetch failed:", err);
    throw new AppError(
      502,
      "Could not reach Lemon Squeezy from the server. Check outbound HTTPS and API key.",
      { code: "LEMON_SQUEEZY_NETWORK_ERROR" },
    );
  }

  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = {};
  }

  if (!res.ok) {
    const detail = lemonErrorDetail(json);
    throw new AppError(
      502,
      detail
        ? `Lemon Squeezy: ${detail}`
        : `Lemon Squeezy request failed (${res.status}). Check API key, store id, and variant IDs on the server.`,
      { code: "LEMON_SQUEEZY_API_ERROR" },
    );
  }

  return json;
}

async function lemonRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonApiResponse> {
  return (await lemonFetch(method, path, body)) as JsonApiResponse;
}

export type CreateCheckoutInput = {
  variantId: string;
  email?: string;
  name?: string;
  custom: Record<string, string>;
  redirectUrl: string;
};

export async function createLemonCheckout(input: CreateCheckoutInput): Promise<{
  checkoutUrl: string;
  checkoutId: string;
}> {
  const payload = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_options: {
          embed: false,
          media: false,
          logo: true,
          desc: true,
          discount: true,
          subscription_preview: true,
          button_color: "#22D35A",
        },
        checkout_data: {
          email: input.email ?? "",
          name: input.name ?? "",
          custom: input.custom,
        },
        product_options: {
          redirect_url: input.redirectUrl,
          receipt_button_text: "Back to Secrela",
          receipt_link_url: input.redirectUrl,
        },
      },
      relationships: {
        store: {
          data: {
            type: "stores",
            id: env.lemonSqueezy.storeId,
          },
        },
        variant: {
          data: {
            type: "variants",
            id: input.variantId,
          },
        },
      },
    },
  };

  const result = await lemonRequest("POST", "/checkouts", payload);
  const data = result?.data;
  const attrs = data?.attributes;
  const url = attrs && typeof attrs.url === "string" ? attrs.url.trim() : "";
  if (!data?.id || !url) {
    throw new AppError(502, "Lemon Squeezy did not return a checkout URL", {
      code: "LEMON_SQUEEZY_CHECKOUT_MISSING",
    });
  }

  return { checkoutUrl: url, checkoutId: String(data.id) };
}

/** Pause / cancel / resume via Lemon Subscriptions API. */
export async function updateLemonSubscription(
  subscriptionId: string,
  attributes: Record<string, unknown>,
): Promise<JsonApiResource> {
  const result = await lemonRequest(
    "PATCH",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      data: {
        type: "subscriptions",
        id: subscriptionId,
        attributes,
      },
    },
  );
  return result.data;
}

export function variantIdForPlan(
  planSlug: PaidPlanSlug,
  interval: BillingInterval,
): string {
  const v = env.lemonSqueezy.variants;
  const byPlan = {
    starter: { monthly: v.starterMonthly, yearly: v.starterYearly },
    team: { monthly: v.teamMonthly, yearly: v.teamYearly },
    business: { monthly: v.businessMonthly, yearly: v.businessYearly },
  } as const;
  return byPlan[planSlug][interval];
}

export function planFromVariantId(
  variantId: string,
): { planSlug: PaidPlanSlug; interval: BillingInterval } | null {
  const id = variantId.trim();
  if (!id) return null;
  const v = env.lemonSqueezy.variants;
  const rows: Array<{
    id: string;
    planSlug: PaidPlanSlug;
    interval: BillingInterval;
  }> = [
    { id: v.starterMonthly, planSlug: "starter", interval: "monthly" },
    { id: v.starterYearly, planSlug: "starter", interval: "yearly" },
    { id: v.teamMonthly, planSlug: "team", interval: "monthly" },
    { id: v.teamYearly, planSlug: "team", interval: "yearly" },
    { id: v.businessMonthly, planSlug: "business", interval: "monthly" },
    { id: v.businessYearly, planSlug: "business", interval: "yearly" },
  ];
  return rows.find((row) => row.id && row.id === id) ?? null;
}

export function lemonVariantIdFromAttributes(
  attrs: Record<string, unknown>,
): string {
  if (attrs.variant_id != null) return String(attrs.variant_id);
  const subItem = attrs.first_subscription_item;
  if (subItem && typeof subItem === "object" && "variant_id" in subItem) {
    const id = (subItem as { variant_id?: unknown }).variant_id;
    if (id != null) return String(id);
  }
  const orderItem = attrs.first_order_item;
  if (orderItem && typeof orderItem === "object" && "variant_id" in orderItem) {
    const id = (orderItem as { variant_id?: unknown }).variant_id;
    if (id != null) return String(id);
  }
  return "";
}

/** List subscriptions for this store (used to activate after hosted checkout return). */
export async function listLemonSubscriptions(filters: {
  email?: string;
  orderId?: string;
}): Promise<JsonApiResource[]> {
  const params = new URLSearchParams();
  params.set("filter[store_id]", env.lemonSqueezy.storeId);
  if (filters.email) params.set("filter[user_email]", filters.email);
  if (filters.orderId) params.set("filter[order_id]", filters.orderId);
  const json = (await lemonFetch(
    "GET",
    `/subscriptions?${params.toString()}`,
  )) as { data?: JsonApiResource | JsonApiResource[] };
  if (!json.data) return [];
  return Array.isArray(json.data) ? json.data : [json.data];
}

export function verifyLemonWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = env.lemonSqueezy.webhookSecret;
  if (!secret || !signatureHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
