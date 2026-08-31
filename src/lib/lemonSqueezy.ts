/**
 * DISABLED — checkout now uses PayPal (`lib/paypal.ts`).
 * This file is kept so we can restore Lemon later; nothing in the live
 * request path imports these functions.
 *
 * Minimal Lemon Squeezy REST client (JSON:API).
 * Docs: https://docs.lemonsqueezy.com/api
 */
import { env } from "../config/env.js";
import { AppError } from "./errors/AppError.js";

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

async function lemonRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonApiResponse> {
  requireConfigured();

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${env.lemonSqueezy.apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json: JsonApiResponse | { errors?: unknown } = {
    data: { type: "", id: "", attributes: {} },
  };
  try {
    json = JSON.parse(text) as JsonApiResponse;
  } catch {
    /* leave empty */
  }

  if (!res.ok) {
    throw new AppError(
      502,
      `Lemon Squeezy request failed (${res.status}). Check API key and variant IDs.`,
      { code: "LEMON_SQUEEZY_API_ERROR" },
    );
  }

  return json as JsonApiResponse;
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
          receipt_button_text: "Back to SecureVault",
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
  const url = String(result.data.attributes.url ?? "");
  if (!url) {
    throw new AppError(502, "Lemon Squeezy did not return a checkout URL", {
      code: "LEMON_SQUEEZY_CHECKOUT_MISSING",
    });
  }

  return { checkoutUrl: url, checkoutId: result.data.id };
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
  planSlug: "starter" | "team",
  interval: "monthly" | "yearly",
): string {
  const v = env.lemonSqueezy.variants;
  if (planSlug === "starter" && interval === "monthly") return v.starterMonthly;
  if (planSlug === "starter" && interval === "yearly") return v.starterYearly;
  if (planSlug === "team" && interval === "monthly") return v.teamMonthly;
  return v.teamYearly;
}
